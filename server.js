const express = require("express");
const cors = require("cors");
const { runTool } = require("./process-runner");
const { classifyDownloadError, sendDownloadError } = require("./download-errors");
const { version: BACKEND_VERSION } = require("./package.json");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const app = express();

const CORS_ORIGINS = String(process.env.CONVERT_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim().replace(/\/$/, ""))
  .filter(Boolean);

// Expose the download headers to cross-origin browser JS. The WordPress tool page
// and this API are different origins, so without this the in-page downloader can't
// read the server's real filename or size — which is what lets iOS/Android save the
// file under the correct name and extension instead of a generic "download".
app.use(
  cors({
    origin(origin, done) {
      if (!origin || !CORS_ORIGINS.length || CORS_ORIGINS.includes(origin.replace(/\/$/, ""))) return done(null, true);
      return done(null, false);
    },
    exposedHeaders: ["Content-Disposition", "Content-Length", "Accept-Ranges", "Retry-After", "X-TrackGrab-Preview"],
    methods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  })
);
app.use(express.json());

// Audio conversion routes (/probe, /convert) used by the SCloud Audio Converter.
const convertRouter = require("./convert");
app.use(convertRouter);

// ── API auth ────────────────────────────────────────────────────────────────
// The API_SECRET must equal the WordPress "Shared API secret": /info requires
// the X-API-Key header, and /download requires a valid, unexpired HMAC signature.
//
// RESILIENCE: this used to be empty-by-default, which meant a redeploy that lost
// the SCLOUD_API_SECRET env var silently flipped the API to "open" — and worse, a
// mismatch (env lost on one side only) rejected EVERY link with a 403 that reads
// "Invalid or expired download link". To make that impossible, we now fall back
// to the SAME baked-in default the WordPress plugin ships with, so the two sides
// always agree out of the box and survive an env-var loss. Set your own matching
// secret on BOTH sides for real security. Escape hatch: SCLOUD_API_OPEN=1 forces
// the old open behaviour (no auth) if you ever need it.
const SCLOUD_SHARED_DEFAULT_SECRET =
  "58a6bad22af816266aa838514070d59a2f36a94d426d1f44a1e144d9024db3b7";
const API_SECRET =
  process.env.SCLOUD_API_OPEN === "1"
    ? ""
    : process.env.SCLOUD_API_SECRET || process.env.API_SECRET || SCLOUD_SHARED_DEFAULT_SECRET;

// Grace window (seconds) that absorbs clock drift between the WordPress box (which
// stamps `exp`) and this box (which checks it). Without it, a VPS clock a few
// minutes ahead of WP made every freshly issued link look already-expired. Tune
// with SIG_LEEWAY_S; 10 minutes is a safe default and does not meaningfully weaken
// the short-lived link.
const SIG_LEEWAY_S = Math.max(0, parseInt(process.env.SIG_LEEWAY_S || "600", 10) || 600);

function apiKeyOk(req) {
  if (!API_SECRET) return true;
  return (req.get("x-api-key") || "") === API_SECRET;
}

// Verify the WordPress download-link signature. V2 signs every plan-controlled
// field, including priority. Legacy links remain valid briefly during deployment,
// but the route never honours priority on a legacy link.
// Returns { ok } plus a `reason` ("expired" | "badsig" | "missing") so the caller
// can log WHICH failure happened — the user-facing message stays the same, but the
// server log finally tells the truth for debugging.
function downloadSigCheck(q) {
  if (!API_SECRET) return { ok: true, reason: "" };
  const exp = parseInt(q.exp || "0", 10);
  if (!exp) return { ok: false, reason: "missing" };
  if (Date.now() / 1000 > exp + SIG_LEEWAY_S) return { ok: false, reason: "expired" };
  let payload = (q.url || "") + "\n" + (q.format || "") + "\n" + (q.title || "") + "\n" + String(q.exp);
  if (String(q.v || "") === "2") {
    payload += "\n" + (q.bitrate || "") + "\n" + (q.meta || "") + "\n" + (q.priority || "");
  } else {
    if (q.bitrate) payload += "\n" + q.bitrate;
    if (q.meta) payload += "\n" + q.meta;
  }
  const expected = crypto.createHmac("sha256", API_SECRET).update(payload).digest("hex");
  const a = Buffer.from(String(q.sig || ""));
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, reason: ok ? "" : "badsig" };
}

function downloadSigOk(q) {
  return downloadSigCheck(q).ok;
}

// Health check — keeps the process reachable (ping this to verify it's up).
app.get("/", (req, res) => {
  res.json({
    status: "TrackGrab server is running ✅",
    uptimeSeconds: Math.floor(process.uptime()),
    downloads: { active: activeJobs, queued: jobQueue.length },
    converter: convertRouter.getStatus(),
  });
});

// Largest usable thumbnail URL from a yt-dlp info object.
function bestThumb(obj) {
  if (!obj) return "";
  if (typeof obj.thumbnail === "string" && obj.thumbnail) return obj.thumbnail;
  const arr = Array.isArray(obj.thumbnails) ? obj.thumbnails : [];
  let best = "", bestW = -1;
  for (const t of arr) {
    if (t && t.url && typeof t.width === "number" && t.width > bestW) { best = t.url; bestW = t.width; }
  }
  if (best) return best;
  for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] && arr[i].url) return arr[i].url; }
  return "";
}

// Humanize a SoundCloud track slug into a title (SC permalinks come from the
// title): ".../you-prod-saint-mike" -> "You Prod Saint Mike".
function titleFromUrl(u) {
  try {
    const parts = new URL(u).pathname.split("/").filter(Boolean);
    let slug = parts.length ? parts[parts.length - 1] : "";
    slug = decodeURIComponent(slug).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!slug) return "";
    return slug.replace(/\b\w/g, (c) => c.toUpperCase());
  } catch (e) {
    return "";
  }
}

// Map one flat-playlist entry to the frontend "track" shape.
function flatTrackShape(e) {
  const turl = e.webpage_url || e.url || "";
  return {
    title: e.title || titleFromUrl(turl),
    url: turl,
    uploader: e.uploader || "",
    duration: typeof e.duration === "number" ? e.duration : null,
    thumbnail: bestThumb(e),
  };
}

// Validate the actual hostname, not a substring in a user-controlled URL.
function validSoundCloudUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      (!url.port || url.port === "80" || url.port === "443") &&
      ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com", "api.soundcloud.com", "api-v2.soundcloud.com"].includes(url.hostname);
  } catch (_) { return false; }
}

// ── SoundCloud api-v2 resolve fallback ──────────────────────────────────────
// yt-dlp's set extractor 404s on SoundCloud "system"/personalized/discover set
// URLs (e.g. /discover/sets/personalized-tracks::user:token). SoundCloud's own web
// player resolves these anonymously with a public client_id via api-v2 — no login.
// We mirror that only as a fallback (normal tracks/playlists still go through
// yt-dlp): scrape a client_id, call /resolve, and hydrate id-only system-playlist
// entries. Uses the same public web API the site itself calls.
let scCachedClientId = "";
// ALL SoundCloud scrape/api traffic goes through curl so it uses the region proxy
// (Node's fetch has no SOCKS support). This is the key reason songverter (EU/US
// egress) succeeds where a direct Singapore request is refused/geo-limited.
async function scCurlText(url, signal, maxBytes) {
  const r = await runTool("curl", curlBase([url]), { signal, timeoutMs: 45000, maxOutput: maxBytes || 6 * 1024 * 1024 });
  if (r.aborted) throw new Error("aborted");
  if (r.code !== 0 || !r.stdout) throw new Error("curl_exit_" + r.code);
  return r.stdout;
}
async function scApiJson(url, signal) {
  const r = await runTool("curl", curlBase(["-w", "\\n%{http_code}", url]), { signal, timeoutMs: 45000, maxOutput: 8 * 1024 * 1024 });
  if (r.aborted) throw new Error("aborted");
  if (r.code !== 0) throw new Error("curl_exit_" + r.code);
  const body = r.stdout || "";
  const nl = body.lastIndexOf("\n");
  const status = parseInt(body.slice(nl + 1).trim(), 10) || 0;
  if (status === 401 || status === 403) scCachedClientId = "";
  if (status < 200 || status >= 300) throw new Error("api_" + status);
  try { return JSON.parse(body.slice(0, nl)); } catch (_) { throw new Error("api_badjson"); }
}
async function scGetClientId(signal, force) {
  if (scCachedClientId && !force) return scCachedClientId;
  const home = await scCurlText("https://soundcloud.com/", signal, 4 * 1024 * 1024);
  const scripts = [...home.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]);
  // The client_id lives in one of the app bundles; the later ones are likeliest.
  for (const src of scripts.reverse()) {
    try {
      const js = await scCurlText(src, signal, 12 * 1024 * 1024);
      const m = js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{22,})"/);
      if (m) { scCachedClientId = m[1]; return scCachedClientId; }
    } catch (_) {}
  }
  throw new Error("client_id_not_found");
}
function scMapTrack(t) {
  return {
    title: t.title || titleFromUrl(t.permalink_url || ""),
    url: t.permalink_url || "",
    uploader: (t.user && t.user.username) || (t.publisher_metadata && t.publisher_metadata.artist) || "",
    duration: typeof t.duration === "number" ? Math.round(t.duration / 1000) : null,
    thumbnail: t.artwork_url || (t.user && t.user.avatar_url) || "",
  };
}
// Build a "related tracks" playlist from a seed track id — SoundCloud's public
// recommendation endpoint (the same source its web player uses for personalized/
// discover sets). Works with an anonymous client_id, so it succeeds where
// /resolve 404s on these "system playlist" URLs.
async function scRelatedFromSeed(seedId, cid, signal) {
  const list = [];
  const seed = await scApiJson(`https://api-v2.soundcloud.com/tracks/${seedId}?client_id=${cid}`, signal).catch(() => null);
  if (seed && seed.permalink_url) list.push(scMapTrack(seed));
  const rel = await scApiJson(`https://api-v2.soundcloud.com/tracks/${seedId}/related?client_id=${cid}&limit=50`, signal).catch(() => null);
  const relTracks = rel && Array.isArray(rel.collection) ? rel.collection : (Array.isArray(rel) ? rel : []);
  for (const t of relTracks) if (t && t.permalink_url) list.push(scMapTrack(t));
  return list;
}

// Resolve a set/track URL via api-v2. Returns {tracks:[...]} for a playlist or
// {single:{...}} for a track, or throws.
async function scResolve(url, signal) {
  const cid = await scGetClientId(signal, false);
  const resolveOnce = (c) => scApiJson(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${c}`, signal);
  let data = null;
  try { data = await resolveOnce(cid); }
  catch (e) {
    if (String(e.message) === "api_401" || String(e.message) === "api_403") {
      try { data = await resolveOnce(await scGetClientId(signal, true)); } catch (_) {}
    }
    // Any other status (e.g. 404 for a system/personalized set) falls through
    // to the seed-based fallback below.
  }
  if (data) {
    if (data.kind === "track") return { single: scMapTrack(data) };
    if (data.kind === "playlist" || data.kind === "system-playlist") {
      const raw = Array.isArray(data.tracks) ? data.tracks : [];
      const ready = [];
      const needIds = [];
      for (const t of raw) {
        if (t && t.permalink_url && t.title) ready.push(scMapTrack(t));
        else if (t && t.id) needIds.push(t.id);
      }
      for (let i = 0; i < needIds.length && i < 500; i += 50) {
        const batch = needIds.slice(i, i + 50);
        try {
          const arr = await scApiJson(`https://api-v2.soundcloud.com/tracks?ids=${batch.join(",")}&client_id=${cid}`, signal);
          if (Array.isArray(arr)) for (const tr of arr) if (tr && tr.permalink_url) ready.push(scMapTrack(tr));
        } catch (_) {}
      }
      if (ready.length) return {
        header: {
          playlist_title: data.title || "Playlist",
          uploader: (data.user && data.user.username) || "",
          uploader_url: (data.user && data.user.permalink_url) || "",
          thumbnail: data.artwork_url || (ready[0] && ready[0].thumbnail) || "",
        },
        total: ready.length, tracks: ready,
      };
    }
  }
  // Personalized / "related tracks" discover set, e.g.
  //   /discover/sets/personalized-tracks::<user>:<seedTrackId>
  // These 404 on /resolve; the trailing id is the seed track. Build the set from
  // that track's public "related" recommendations (what songverter does too).
  const seedMatch = url.match(/personalized-tracks::[^:/?#]+:(\d+)/) || url.match(/track-stations:(\d+)/);
  if (seedMatch) {
    const tracks = await scRelatedFromSeed(seedMatch[1], cid, signal);
    if (tracks.length) return {
      header: {
        playlist_title: `Related tracks: ${tracks[0].title}`,
        uploader: tracks[0].uploader || "",
        uploader_url: "",
        thumbnail: tracks[0].thumbnail || "",
      },
      total: tracks.length, tracks,
    };
  }
  throw new Error("not_resolvable");
}

// curl argument list, routed through the SoundCloud proxy when configured so the
// request egresses from the allowed region (curl speaks socks5h/http, unlike
// Node's fetch). Callers append their own URL (and -o file for downloads).
function curlBase(extra) {
  const a = ["-s", "-L", "--max-time", "120"];
  if (SOUNDCLOUD_PROXY) a.push("--proxy", SOUNDCLOUD_PROXY);
  a.push("-A", `Mozilla/5.0 (compatible; ScloudTrackGrab/${BACKEND_VERSION})`);
  // SoundCloud's media/stream endpoints reject anonymous (client_id-only) requests
  // for some tracks with 401 — the web player authenticates with an OAuth token.
  // Send one when configured so progressive/hls renditions unlock like the site.
  if (SOUNDCLOUD_OAUTH_TOKEN) a.push("-H", `Authorization: OAuth ${SOUNDCLOUD_OAUTH_TOKEN}`);
  return a.concat(extra || []);
}
// Resolve a track's direct PROGRESSIVE media URL via api-v2, the way SoundCloud's
// web player (and web downloaders) do: read the track's media.transcodings and
// its track_authorization, pick the progressive (plain file) rendition, and ask
// the media endpoint for the CDN URL. This recovers tracks that yt-dlp reports as
// "DRM protected" only because it resolves streams with client_id alone (no
// track_authorization) and is then offered only the encrypted-HLS rendition. It
// does NOT decrypt anything — it uses the same public progressive file the site
// serves. Returns the CDN URL string, or null.
// Ask the media endpoint for the real CDN URL of one transcoding. SoundCloud's
// newer streams are unlocked by the track's track_authorization (the web player
// sends that WITHOUT a client_id); older ones need client_id. Try both forms.
async function scResolveTranscoding(tUrl, cid, ta, signal) {
  const sep = tUrl.includes("?") ? "&" : "?";
  const forms = [];
  if (ta) forms.push(`${tUrl}${sep}track_authorization=${ta}`);
  if (ta) forms.push(`${tUrl}${sep}client_id=${cid}&track_authorization=${ta}`);
  forms.push(`${tUrl}${sep}client_id=${cid}`);
  for (const u of forms) {
    try { const j = await scApiJson(u, signal); if (j && typeof j.url === "string") return j.url; }
    catch (_) { /* try next form */ }
  }
  return null;
}
// Resolve a downloadable media URL for a track that yt-dlp couldn't get. Reads the
// track's media.transcodings + track_authorization and resolves the PROGRESSIVE
// rendition first (plain file), then plain non-encrypted HLS. Skips *-encrypted-hls
// (real DRM). Returns a URL yt-dlp can download+convert, or null.
async function scProgressiveMediaUrl(trackUrl, signal, deadline) {
  let cid;
  try { cid = await scGetClientId(signal, false); }
  catch (e) { console.warn("[direct] client_id failed:", e.message); return null; }
  const resolveTrack = async () => scApiJson(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(trackUrl)}&client_id=${cid}`, signal);
  let track;
  try { track = await resolveTrack(); }
  catch (e) {
    try { cid = await scGetClientId(signal, true); track = await resolveTrack(); }
    catch (e2) { console.warn("[direct] track resolve failed:", e2.message); return null; }
  }
  if (!track || track.kind !== "track") { console.warn("[direct] not a track:", track && track.kind); return null; }
  const trans = track.media && Array.isArray(track.media.transcodings) ? track.media.transcodings : [];
  console.warn("[direct] transcodings:", (trans.map((t) => t.format && t.format.protocol + (t.snipped ? "/snip" : "")).join(", ") || "none"), "| track_authorization:", track.track_authorization ? "yes" : "no");
  const ta = track.track_authorization ? encodeURIComponent(track.track_authorization) : "";
  const proto = (t) => (t && t.format && t.format.protocol) || "";
  // Progressive (plain file) first, then plain HLS. Encrypted-HLS is skipped.
  const prog = trans.filter((t) => t && t.url && proto(t) === "progressive" && !t.snipped);
  const hls = trans.filter((t) => t && t.url && proto(t) === "hls" && !t.snipped);
  const candidates = [...prog, ...hls];
  if (!candidates.length) { console.warn("[direct] no non-encrypted rendition (only encrypted-hls)"); return null; }
  for (const c of candidates) {
    if (controllerAborted(signal)) return null;
    const media = await scResolveTranscoding(c.url, cid, ta, signal);
    if (media) { console.warn("[direct] media url resolved via", proto(c)); return media; }
  }
  console.warn("[direct] all renditions failed to resolve a media url");
  return null;
}
function controllerAborted(signal) { return signal && signal.aborted; }

function soundCloudArgs() {
  // Explicitly try every format supported by the extractor. MP3 output does not
  // require an MP3 source; AAC/Opus are converted by FFmpeg. Local yt-dlp config
  // must not force an obsolete format, simulate downloads or enable DRM formats.
  const args = ["--ignore-config", "--extractor-args", "soundcloud:formats=*", "--socket-timeout", "20", "--cache-dir", YTDLP_CACHE_DIR];
  // Route through the configured region proxy first (recovers region-locked tracks).
  if (SOUNDCLOUD_PROXY) args.push("--proxy", SOUNDCLOUD_PROXY);
  // Then yt-dlp's own geo circumvention, unless explicitly turned off.
  if (!GEO_BYPASS_OFF) {
    if (GEO_BYPASS_COUNTRY) args.push("--geo-bypass-country", GEO_BYPASS_COUNTRY);
    else args.push("--geo-bypass");
  }
  // Authenticated requests (private/unlisted tracks + personalized discover sets).
  if (SOUNDCLOUD_COOKIE_FILE) args.push("--cookies", SOUNDCLOUD_COOKIE_FILE);
  return args;
}

// The extractor marks previews in the source format ID and ranks them below
// full streams. Flat playlist entries have no format data until downloaded.
function previewOnly(meta) {
  const formats = Array.isArray(meta?.formats) ? meta.formats.filter((format) => format && format.url && !format.has_drm) : [];
  if (!formats.length) return null;
  return formats.every((format) => /(?:^|[_-])preview(?:$|[_-])/i.test(String(format.format_id || "")));
}

app.get("/info", async (req, res) => {
  if (!apiKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const url = req.query.url;
  if (!validSoundCloudUrl(url)) return res.status(400).json({ error: "Invalid SoundCloud URL", code: "invalid_url", retryable: false });
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await runTool(YTDLP_BIN, [...soundCloudArgs(), "-J", "--flat-playlist", "--no-playlist", "--no-warnings", "--", url],
        { timeoutMs: 45000, maxOutput: 32 * 1024 * 1024, signal: controller.signal });
      if (result.aborted || controller.signal.aborted || res.destroyed) return;
      if (result.code === 0 && !result.signal && !result.error && !result.timedOut) break;
      const info = classifyDownloadError(result.stderr, result);
      if (!info.retryable || attempt === 1) {
        console.error(`[info] code=${result.code} signal=${result.signal || "none"} ${result.stderr || result.error?.message || info.code}`);
        // Fallback: SoundCloud api-v2 resolve for system/personalized/discover sets
        // (and unlisted items) the yt-dlp set extractor can't read. No login needed.
        try {
          const r = await scResolve(url, controller.signal);
          if (controller.signal.aborted || res.writableEnded) return;
          if (r && r.tracks && r.tracks.length) {
            return res.json({ type: "playlist", header: r.header, total: r.total, tracks: r.tracks });
          }
          if (r && r.single && r.single.url) {
            const t = r.single;
            return res.json({ title: t.title, uploader: t.uploader, thumbnail: t.thumbnail, duration: t.duration, url: t.url, preview_only: null });
          }
        } catch (fallbackErr) { console.warn("[info] resolve fallback failed:", fallbackErr.message); }
        return sendDownloadError(res, info);
      }
      if (!await retryDelay(DOWNLOAD_RETRY_DELAY_MS, controller.signal)) return;
    }
    let meta;
    try { meta = JSON.parse(result.stdout); }
    catch (_) { return sendDownloadError(res, classifyDownloadError("failed to parse track data")); }
    if (!meta || typeof meta !== "object") return sendDownloadError(res, classifyDownloadError("no audio metadata"));
    if (Array.isArray(meta.entries)) {
      const tracks = meta.entries.filter((entry) => entry && validSoundCloudUrl(entry.webpage_url || entry.url)).map(flatTrackShape);
      return res.json({ type: "playlist", header: {
        playlist_title: meta.title || meta.album || "Playlist", uploader: meta.uploader || meta.album_artist || "",
        uploader_url: meta.uploader_url || "", thumbnail: bestThumb(meta),
      }, total: meta.playlist_count || tracks.length, tracks });
    }
    return res.json({ title: meta.title, uploader: meta.uploader, thumbnail: bestThumb(meta), duration: meta.duration,
      description: meta.description, like_count: meta.like_count, view_count: meta.view_count,
      preview_only: previewOnly(meta), url });
  } catch (error) {
    console.error("info request failed:", error);
    sendDownloadError(res, classifyDownloadError("", { error }));
  } finally {
    req.removeListener("aborted", abort);
    res.removeListener("close", abort);
  }
});

// Supported formats → yt-dlp target audio format, download-name extension, MIME.
// SoundCloud is audio-only, so mp4/m4a both resolve to an MP4 (ISO) audio container.
// `lossless` formats (WAV/FLAC) ignore bitrate; `canEmbed` = format supports tags/cover
// (WAV has no usable tag container, so metadata embedding is skipped there).
const DOWNLOAD_FORMATS = {
  mp3:  { audioFormat: "mp3",  ext: "mp3",  mime: "audio/mpeg", lossless: false, canEmbed: true  },
  m4a:  { audioFormat: "m4a",  ext: "m4a",  mime: "audio/mp4",  lossless: false, canEmbed: true  },
  mp4:  { audioFormat: "m4a",  ext: "mp4",  mime: "audio/mp4",  lossless: false, canEmbed: true  },
  wav:  { audioFormat: "wav",  ext: "wav",  mime: "audio/wav",  lossless: true,  canEmbed: false },
  flac: { audioFormat: "flac", ext: "flac", mime: "audio/flac", lossless: true,  canEmbed: true  },
};

// Real audio extensions the /download picker is allowed to serve. Used to make
// sure we never hand back an embedded cover-art image (.jpg/.webp) as the track.
// Configurable binary locations. Defaults keep the old behaviour (bare names on
// PATH) so existing VPS installs are unaffected; a Render/container build can set
// YTDLP_PATH / FFMPEG_LOCATION to point at ./bin without code changes.
const YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG_LOCATION = process.env.FFMPEG_LOCATION || ""; // dir containing ffmpeg/ffprobe
// Persist yt-dlp's cache (SoundCloud client_id, extractor data) between download
// jobs so each new download skips re-resolving it — a real per-request round-trip
// saved. tmp is always writable, even on read-only container filesystems.
const YTDLP_CACHE_DIR = process.env.YTDLP_CACHE_DIR || path.join(os.tmpdir(), "yt-dlp-cache");
// Optional outbound proxy for SoundCloud requests. Point it at an egress in a
// region where the catalogue is available to recover "unavailable in the server's
// region" tracks (this is how region-locked streams/previews are reached). Off
// unless set. Accepts SOUNDCLOUD_PROXY, else the conventional HTTPS/HTTP_PROXY.
const SOUNDCLOUD_PROXY = String(process.env.SOUNDCLOUD_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "").trim();
// yt-dlp's built-in geo circumvention (spoofs X-Forwarded-For). Enabled by default
// since it is harmless for unrestricted tracks and often clears a geo block. Set
// SOUNDCLOUD_GEO_BYPASS_COUNTRY=US (etc.) to force a country, or =off to disable.
const GEO_BYPASS_COUNTRY = String(process.env.SOUNDCLOUD_GEO_BYPASS_COUNTRY || "").trim().toUpperCase();
const GEO_BYPASS_OFF = GEO_BYPASS_COUNTRY === "OFF" || GEO_BYPASS_COUNTRY === "0" || GEO_BYPASS_COUNTRY === "NONE";
// Optional SoundCloud authentication so the backend can fetch content the account
// is entitled to — private/unlisted tracks and personalized "discover" sets
// (e.g. .../discover/sets/personalized-tracks::user:token) that SoundCloud returns
// 404 for when unauthenticated. Provide EITHER a full Netscape cookies.txt exported
// from a logged-in browser (SOUNDCLOUD_COOKIES=/path), OR just the oauth_token cookie
// value (SOUNDCLOUD_OAUTH_TOKEN=...), from which we materialize a minimal cookies file
// that yt-dlp reads. Nothing is sent anywhere except SoundCloud via yt-dlp.
const SOUNDCLOUD_COOKIES = String(process.env.SOUNDCLOUD_COOKIES || "").trim();
const SOUNDCLOUD_OAUTH_TOKEN = String(process.env.SOUNDCLOUD_OAUTH_TOKEN || "").trim();
let SOUNDCLOUD_COOKIE_FILE = "";
(function resolveSoundcloudCookies() {
  if (SOUNDCLOUD_COOKIES) {
    if (fs.existsSync(SOUNDCLOUD_COOKIES)) SOUNDCLOUD_COOKIE_FILE = SOUNDCLOUD_COOKIES;
    else console.warn(`[auth] SOUNDCLOUD_COOKIES path not found: ${SOUNDCLOUD_COOKIES}`);
    return;
  }
  if (SOUNDCLOUD_OAUTH_TOKEN) {
    try {
      const file = path.join(os.tmpdir(), "sc-oauth-cookies.txt");
      const expiry = Math.floor(Date.now() / 1000) + 400 * 24 * 3600;
      // Netscape cookie format: domain, subdomains, path, secure, expiry, name, value.
      fs.writeFileSync(file, `# Netscape HTTP Cookie File\n.soundcloud.com\tTRUE\t/\tTRUE\t${expiry}\toauth_token\t${SOUNDCLOUD_OAUTH_TOKEN}\n`, { mode: 0o600 });
      SOUNDCLOUD_COOKIE_FILE = file;
    } catch (error) { console.warn("[auth] could not write oauth cookie file:", error.message); }
  }
})();

// Clamp a requested MP3 bitrate to a sane CBR value; "" means "let yt-dlp pick best".
function normalizeBitrate(raw) {
  const n = parseInt(String(raw || ""), 10);
  if (!Number.isFinite(n)) return "";
  if (n < 64) return "64";
  if (n > 320) return "320";
  return String(n);
}

// Bitrate (kbps) a lossy download is encoded at. SoundCloud only serves a
// ~128 kbps source, but customers judge quality by what a bitrate checker /
// file-properties dialog reports, and a Pro buyer who sees "128 kbps" on the
// file they paid for opens a refund dispute. So lossy output is ALWAYS encoded
// at a real target bitrate (default 320) — never left at yt-dlp's VBR guess,
// which for a 128 kbps source would advertise ~128. The WordPress signed link
// supplies the plan bitrate; 320 is the floor/default when it doesn't.
function lossyBitrate(opts) {
  const n = parseInt(String(opts && opts.bitrate ? opts.bitrate : ""), 10);
  if (!Number.isFinite(n) || n < 64) return "320";
  if (n > 320) return "320";
  return String(n);
}

// Extra ffmpeg args for the AUDIO-EXTRACT postprocessor only (yt-dlp key
// "ExtractAudio:"), so they never touch the separate cover-art embed step.
// --audio-quality already sets -b:a <brate>k; for MP3 we add matching
// -minrate/-maxrate/-bufsize so libmp3lame produces a TRUE constant bitrate and
// a bitrate checker reports exactly that value (e.g. 320) with no ambiguity.
// AAC (m4a) reports ~brate from -b:a alone; lossless (wav/flac) needs nothing.
function extractAudioCbrArgs(fmt, opts) {
  if (fmt.lossless || fmt.audioFormat !== "mp3") return "";
  const brate = lossyBitrate(opts);
  return `-minrate ${brate}k -maxrate ${brate}k -bufsize ${brate}k`;
}

// Build the yt-dlp argument list for a format + plan-derived options.
// - bitrate: lossy formats encode CBR at "<bitrate>K" (default 320); lossless ignore it.
// - meta: embed title/artist/etc. tags and cover art (where the container supports it).
function buildYtdlpArgs(fmt, opts) {
  const args = ["-x", "--audio-format", fmt.audioFormat];

  if (!fmt.lossless) {
    // Always target a real bitrate (default 320). For MP3 the CBR is enforced by
    // the audio-extract post-processor args (see extractAudioCbrArgs) so the
    // finished file advertises this exact bitrate.
    args.push("--audio-quality", `${lossyBitrate(opts)}K`);
  }

  if (opts.meta && fmt.canEmbed) {
    // Tags (ID3/MP4/Vorbis comments) are reliable on every container we allow.
    args.push("--embed-metadata");
    // Cover-art embedding is only reliable for the lossy containers. Embedding a
    // picture into FLAC via ffmpeg can fail the whole job, so skip the thumbnail
    // there (tags still applied). --convert-thumbnails jpg avoids webp rejection.
    if (!fmt.lossless) {
      args.push("--embed-thumbnail", "--convert-thumbnails", "jpg");
    }
  }

  return args;
}

// Diagnostics also use the bounded process runner.
function toolVersion(cmd, args, cb) {
  runTool(cmd, args, { timeoutMs: 8000 }).then((result) => {
    if (result.error || result.timedOut || result.signal || result.code !== 0) {
      return cb({ ok: false, error: result.error?.code || (result.timedOut ? "timeout" : result.signal || `exit_${result.code}`) });
    }
    cb({ ok: true, version: String(result.stdout || result.stderr).split(/\r?\n/)[0].slice(0, 140) });
  });
}
function ffmpegProbePath() {
  return FFMPEG_LOCATION ? path.join(FFMPEG_LOCATION, "ffmpeg") : (process.env.FFMPEG_PATH || "ffmpeg");
}
function ffprobeProbePath() {
  return FFMPEG_LOCATION ? path.join(FFMPEG_LOCATION, "ffprobe") : (process.env.FFPROBE_PATH || "ffprobe");
}

// Verify that yt-dlp's finished file really is the requested container/codec.
// This prevents a leftover source stream from being served under a false .wav,
// .flac or .mp4 extension when post-processing fails part-way through.
async function verifyDownloadedOutput(input, requested, signal) {
  const result = await runTool(ffprobeProbePath(), ["-v", "error", "-show_entries",
    "format=format_name,duration:stream=codec_name,codec_type", "-of", "json", input],
    { timeoutMs: 15000, maxOutput: 20000, signal });
  if (result.error || result.code !== 0 || result.signal || result.timedOut || result.aborted) {
    return { ok: false, detail: result.error?.code || result.signal || (result.timedOut ? "probe_timeout" : "probe_failed") };
  }
  try {
    const data = JSON.parse(result.stdout);
    const container = String(data?.format?.format_name || "").toLowerCase();
    const codecs = (Array.isArray(data?.streams) ? data.streams : [])
      .filter((stream) => stream?.codec_type === "audio").map((stream) => String(stream.codec_name || "").toLowerCase());
    const ok =
      (requested === "mp3" && container.includes("mp3") && codecs.includes("mp3")) ||
      ((requested === "m4a" || requested === "mp4") && /mov|mp4|m4a/.test(container) && codecs.includes("aac")) ||
      (requested === "wav" && container.includes("wav") && codecs.some((codec) => codec.startsWith("pcm_"))) ||
      (requested === "flac" && container.includes("flac") && codecs.includes("flac"));
    return { ok, detail: `container=${container || "?"}; codecs=${codecs.join(",") || "?"}` };
  } catch (_) { return { ok: false, detail: "invalid_ffprobe_output" }; }
}

function retryDelay(ms, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const abort = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(true); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// ── Priority-aware job queue ────────────────────────────────────────────────
// Bounds concurrent yt-dlp/ffmpeg jobs so the box stays responsive, and lets
// Pro ("priority") downloads jump ahead of the free queue — the server side of
// "priority server queue / faster processing". Tune with MAX_CONCURRENT env.
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT || "2", 10) || 2);
const MAX_QUEUE = Math.max(1, parseInt(process.env.MAX_QUEUE || "30", 10) || 30);
const DOWNLOAD_TIMEOUT_S = Math.max(60, parseInt(process.env.DOWNLOAD_TIMEOUT_S || "900", 10) || 900);
// Parallel HLS fragment downloads per yt-dlp job. 4 is a good default; raise via
// YTDLP_FRAGMENTS on a beefier box, but keep it modest so N jobs × N fragments
// don't saturate the network.
const YTDLP_FRAGMENTS = Math.min(8, Math.max(1, parseInt(process.env.YTDLP_FRAGMENTS || "4", 10) || 4));
const DOWNLOAD_ATTEMPTS = Math.min(3, Math.max(1, parseInt(process.env.DOWNLOAD_ATTEMPTS || "2", 10) || 2));
const DOWNLOAD_RETRY_DELAY_MS = Math.min(10000, Math.max(0, Number(process.env.DOWNLOAD_RETRY_DELAY_MS ?? "2000") || 0));
const DOWNLOAD_QUEUE_TIMEOUT_S = Math.max(1, parseInt(process.env.DOWNLOAD_QUEUE_TIMEOUT_S || "60", 10) || 60);
const SHUTDOWN_GRACE_S = Math.max(15, parseInt(process.env.SHUTDOWN_GRACE_S || String(DOWNLOAD_TIMEOUT_S + 30), 10) || 930);
const activeControllers = new Set();
const activeWorkDirs = new Set();
let shuttingDown = false;
let activeJobs = 0;
const jobQueue = []; // { priority: 0|1, run: (release) => void }

function pumpQueue() {
  while (activeJobs < MAX_CONCURRENT && jobQueue.length) {
    const job = jobQueue.shift();
    activeJobs++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeJobs--;
      pumpQueue();
    };
    try {
      Promise.resolve(job.run(release)).catch((error) => { console.error("job run error:", error); release(); });
    } catch (e) {
      console.error("job run error:", e);
      release();
    }
  }
}

function scheduleJob(priority, run, cancel) {
  if (shuttingDown || (activeJobs >= MAX_CONCURRENT && jobQueue.length >= MAX_QUEUE)) return null;
  const job = { priority: priority ? 1 : 0, run, cancel };
  if (job.priority) {
    // Insert ahead of all normal jobs, behind any waiting priority jobs (FIFO within a tier).
    let i = 0;
    while (i < jobQueue.length && jobQueue[i].priority >= job.priority) i++;
    jobQueue.splice(i, 0, job);
  } else {
    jobQueue.push(job);
  }
  pumpQueue();
  return job;
}

// Download one track in an isolated directory. A playlist client should request
// each track separately, continuing past unavailable entries.
app.get("/download", (req, res) => {
  const fields = ["url", "title", "format", "bitrate", "meta", "priority", "exp", "sig", "v"];
  if (fields.some((field) => req.query[field] !== undefined && typeof req.query[field] !== "string")) {
    return res.status(400).json({ error: "Invalid download parameters", code: "invalid_request", retryable: false });
  }
  const url = req.query.url;
  if (!validSoundCloudUrl(url)) return res.status(400).json({ error: "Invalid SoundCloud URL", code: "invalid_url", retryable: false });
  const requested = String(req.query.format || "mp3").toLowerCase();
  const fmt = DOWNLOAD_FORMATS[requested];
  if (!fmt) return res.status(400).json({ error: "Unsupported output format", code: "invalid_format", retryable: false });
  const sigCheck = downloadSigCheck(req.query);
  if (!sigCheck.ok) {
    console.warn(`[sig] rejected /download reason=${sigCheck.reason}`);
    return res.status(403).json({ error: "Invalid or expired download link", code: "bad_link", reason: sigCheck.reason, retryable: false });
  }
  // --no-playlist still expands a pure SoundCloud set URL. Each entry needs its
  // own request; otherwise all entries collide in this job's single output file.
  const parsedDownloadUrl = new URL(url);
  const isPlaylistUrl = ["api.soundcloud.com", "api-v2.soundcloud.com"].includes(parsedDownloadUrl.hostname)
    ? /^\/playlists\/\d+(?:\/|$)/.test(parsedDownloadUrl.pathname)
    : /^\/[^/]+\/sets\/[^/]+(?:\/|$)/.test(parsedDownloadUrl.pathname);
  if (isPlaylistUrl) {
    return sendDownloadError(res, { status: 400, code: "playlist_requires_tracks", category: "playlist",
      message: "This link is a playlist. Choose a track from the results to download.",
      hint: "Use the playlist results to download each available track separately.", retryable: false, retryAfterSeconds: 0 });
  }
  const opts = { bitrate: normalizeBitrate(req.query.bitrate), meta: req.query.meta === "1" };
  const priority = req.query.v === "2" && req.query.priority === "1";
  const safeTitle = String(req.query.title || "track").replace(/[^a-zA-Z0-9_\- ]/g, "").trim().slice(0, 180) || "track";
  const controller = new AbortController();
  let queuedJob, queueTimer, started = false;
  const removeQueued = () => {
    const index = jobQueue.indexOf(queuedJob);
    if (index >= 0) jobQueue.splice(index, 1);
    clearTimeout(queueTimer);
  };
  const abort = () => {
    if (res.writableEnded) return;
    controller.abort();
    if (!started) removeQueued();
  };
  req.once("aborted", abort);
  res.once("close", abort);
  const stopWaiting = (code, message) => {
    removeQueued();
    sendDownloadError(res, { status: 503, code, category: "queue", message, hint: "Please try again in a moment.", retryable: true, retryAfterSeconds: 3 });
    controller.abort();
  };
  queuedJob = scheduleJob(priority, async (release) => {
    started = true;
    clearTimeout(queueTimer);
    let workDir;
    activeControllers.add(controller);
    const deadline = Date.now() + DOWNLOAD_TIMEOUT_S * 1000;
    try {
      // IncomingMessage.destroyed is also true for a normally completed GET.
      // The AbortController/response track a real lost client instead.
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), "trackgrab-"));
      activeWorkDirs.add(workDir);
      let result, produced, info, isPreview = false;
      let includeMeta = opts.meta;
      let triedPreviewFallback = false;
      let triedDirect = false;
      for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
        const attemptDir = path.join(workDir, String(attempt));
        fs.mkdirSync(attemptDir);
        const outTemplate = path.join(attemptDir, "audio.%(ext)s");
        result = await runTool(YTDLP_BIN, [
          ...soundCloudArgs(), ...buildYtdlpArgs(fmt, { ...opts, meta: includeMeta }),
          // Try every available source, including a preview when that is all
          // SoundCloud exposes. Prefer full streams explicitly; check availability
          // before selection so a dead rendition does not hide a usable one.
          "--format", "bestaudio[format_id!*=preview]/best[format_id!*=preview]/bestaudio/best", "--check-formats",
          "--concurrent-fragments", String(YTDLP_FRAGMENTS), "--retries", "3", "--fragment-retries", "5",
          "--abort-on-unavailable-fragments", "--postprocessor-args", "ffmpeg:-threads 2",
          ...(extractAudioCbrArgs(fmt, opts) ? ["--postprocessor-args", "ExtractAudio:" + extractAudioCbrArgs(fmt, opts)] : []),
          ...(FFMPEG_LOCATION ? ["--ffmpeg-location", FFMPEG_LOCATION] : []),
          "--no-mtime", "--no-playlist", "--no-progress", "--no-simulate",
          "--print", "after_move:TRACKGRAB_FILE:%(filepath)s",
          "--print", "after_move:TRACKGRAB_SOURCE:%(format_id)s", "-o", outTemplate, "--", url,
        ], { signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()) });
        if (result.aborted || controller.signal.aborted || res.destroyed) return;
        if (result.code === 0 && !result.signal && !result.error && !result.timedOut) {
          // Require both yt-dlp's completed post-processing marker and the exact
          // expected file. Never serve a source, thumbnail or interrupted output.
          const completed = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("TRACKGRAB_FILE:")).map((line) => line.slice("TRACKGRAB_FILE:".length));
          const candidates = [...new Set([fmt.audioFormat, fmt.ext])].map((ext) => path.join(attemptDir, `audio.${ext}`));
          produced = candidates.find((file) => completed.some((name) => path.resolve(name) === path.resolve(file)) && fs.existsSync(file) && fs.statSync(file).size > 0);
          if (produced) {
            const sourceLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("TRACKGRAB_SOURCE:"));
            isPreview = /(?:^|[_-])preview(?:$|[_-])/i.test((sourceLine || "").slice("TRACKGRAB_SOURCE:".length));
            break;
          }
          info = classifyDownloadError("no audio file was completed");
        } else info = classifyDownloadError(result.stderr, result);
        console.warn(`[download] attempt=${attempt + 1} code=${result.code} signal=${result.signal || "none"} reason=${info.code} ${result.stderr || result.error?.message || ""}`);
        const optionalMetaFailure = includeMeta && result.code === 1 && !result.signal && !result.error && !result.timedOut &&
          /thumbnail|cover art|artwork|embedmetadata|embedthumbnail|metadata.*embed|embed.*metadata/i.test(result.stderr) &&
          !["drm_protected", "geo_restricted", "track_private", "rate_limited", "preview_only"].includes(info.code);
        if (optionalMetaFailure) includeMeta = false;
        if (attempt + 1 >= DOWNLOAD_ATTEMPTS || (!optionalMetaFailure && !info.retryable) || Date.now() >= deadline) {
          // FULL-audio recovery: yt-dlp reports "DRM protected"/geo/unavailable for
          // some tracks only because it resolves streams with client_id alone and is
          // offered nothing but encrypted-HLS. SoundCloud still serves a normal
          // PROGRESSIVE file when asked with the track's track_authorization (what the
          // web player and web downloaders use). Resolve that direct media URL and let
          // yt-dlp download+convert it — a full track, not a preview.
          const directCodes = ["drm_protected", "geo_restricted", "audio_unavailable", "upstream_forbidden", "preview_only", "download_failed", "upstream_unavailable"];
          if (!triedDirect && directCodes.includes(info.code) && !controller.signal.aborted && !res.destroyed && Date.now() < deadline) {
            triedDirect = true;
            try {
              const mediaUrl = await scProgressiveMediaUrl(url, controller.signal, deadline);
              if (mediaUrl && !controller.signal.aborted && !res.destroyed) {
                const dDir = path.join(workDir, "direct");
                fs.mkdirSync(dDir);
                const dOut = path.join(dDir, "audio.%(ext)s");
                const dr = await runTool(YTDLP_BIN, [
                  ...soundCloudArgs(), ...buildYtdlpArgs(fmt, { ...opts, meta: false }),
                  "--retries", "3", "--postprocessor-args", "ffmpeg:-threads 2",
                  ...(extractAudioCbrArgs(fmt, opts) ? ["--postprocessor-args", "ExtractAudio:" + extractAudioCbrArgs(fmt, opts)] : []),
                  ...(FFMPEG_LOCATION ? ["--ffmpeg-location", FFMPEG_LOCATION] : []),
                  "--no-mtime", "--no-progress", "--no-simulate",
                  "--print", "after_move:TRACKGRAB_FILE:%(filepath)s", "-o", dOut, "--", mediaUrl,
                ], { signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()) });
                if (dr.aborted || controller.signal.aborted || res.destroyed) return;
                if (dr.code === 0 && !dr.signal && !dr.error && !dr.timedOut) {
                  const doneD = dr.stdout.split(/\r?\n/).filter((line) => line.startsWith("TRACKGRAB_FILE:")).map((line) => line.slice("TRACKGRAB_FILE:".length));
                  const candsD = [...new Set([fmt.audioFormat, fmt.ext])].map((ext) => path.join(dDir, `audio.${ext}`));
                  const pD = candsD.find((file) => doneD.some((name) => path.resolve(name) === path.resolve(file)) && fs.existsSync(file) && fs.statSync(file).size > 0);
                  if (pD) { produced = pD; isPreview = false; break; }
                }
                console.warn(`[download] direct-progressive fallback failed code=${dr.code} ${dr.stderr || dr.error?.message || ""}`);
              }
            } catch (directErr) { console.warn("[download] direct-progressive resolve failed:", directErr.message); }
          }
          // Last resort so no listed track hard-fails: when SoundCloud gave us no
          // usable full/available stream (geo, Go+/DRM, "preview only", forbidden),
          // try once more forcing ANY playable source — including the public 30s
          // preview snippet — with the availability/fragment guards relaxed so a
          // flaky-but-present snippet still downloads. This does NOT circumvent DRM
          // or fabricate audio SoundCloud withholds; it only grabs what is playable.
          const previewFallbackCodes = ["geo_restricted", "drm_protected", "preview_only", "audio_unavailable", "upstream_forbidden", "upstream_unavailable", "download_failed"];
          if (!triedPreviewFallback && previewFallbackCodes.includes(info.code) && !controller.signal.aborted && !res.destroyed && Date.now() < deadline) {
            triedPreviewFallback = true;
            const pvDir = path.join(workDir, "preview");
            fs.mkdirSync(pvDir);
            const pvOut = path.join(pvDir, "audio.%(ext)s");
            const pv = await runTool(YTDLP_BIN, [
              ...soundCloudArgs(), ...buildYtdlpArgs(fmt, { ...opts, meta: false }),
              // Accept anything playable, preview snippet included; no format
              // pre-check and skip (don't abort on) unavailable fragments.
              "--format", "bestaudio/best/worst",
              "--concurrent-fragments", String(YTDLP_FRAGMENTS), "--retries", "3", "--fragment-retries", "5",
              "--no-abort-on-unavailable-fragments", "--postprocessor-args", "ffmpeg:-threads 2",
              ...(extractAudioCbrArgs(fmt, opts) ? ["--postprocessor-args", "ExtractAudio:" + extractAudioCbrArgs(fmt, opts)] : []),
              ...(FFMPEG_LOCATION ? ["--ffmpeg-location", FFMPEG_LOCATION] : []),
              "--no-mtime", "--no-playlist", "--no-progress", "--no-simulate",
              "--print", "after_move:TRACKGRAB_FILE:%(filepath)s", "-o", pvOut, "--", url,
            ], { signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()) });
            if (pv.aborted || controller.signal.aborted || res.destroyed) return;
            if (pv.code === 0 && !pv.signal && !pv.error && !pv.timedOut) {
              const done2 = pv.stdout.split(/\r?\n/).filter((line) => line.startsWith("TRACKGRAB_FILE:")).map((line) => line.slice("TRACKGRAB_FILE:".length));
              const cands2 = [...new Set([fmt.audioFormat, fmt.ext])].map((ext) => path.join(pvDir, `audio.${ext}`));
              const p2 = cands2.find((file) => done2.some((name) => path.resolve(name) === path.resolve(file)) && fs.existsSync(file) && fs.statSync(file).size > 0);
              if (p2) { produced = p2; isPreview = true; break; }
            }
            console.warn(`[download] preview-fallback failed code=${pv.code} signal=${pv.signal || "none"} ${pv.stderr || pv.error?.message || ""}`);
          }
          return sendDownloadError(res, info);
        }
        if (!await retryDelay(DOWNLOAD_RETRY_DELAY_MS, controller.signal)) return;
      }
      const verified = await verifyDownloadedOutput(produced, requested, controller.signal);
      if (controller.signal.aborted || res.destroyed) return;
      if (!verified.ok) {
        console.error(`[download] invalid ${requested} output: ${verified.detail}`);
        return sendDownloadError(res, { status: 502, code: "invalid_output", category: "wrong-output-format",
          message: "The audio file could not be prepared correctly.", hint: "Please try again later.", retryable: false, retryAfterSeconds: 0 });
      }
      const safeFile = `${safeTitle}${isPreview ? " (preview)" : ""}.${fmt.ext}`;
      res.setHeader("Content-Disposition", `attachment; filename="${safeFile}"; filename*=UTF-8''${encodeURIComponent(safeFile)}`);
      res.setHeader("X-TrackGrab-Preview", isPreview ? "1" : "0");
      res.setHeader("Content-Type", fmt.mime);
      res.setHeader("Content-Length", fs.statSync(produced).size);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "private, no-store");
      await new Promise((resolve) => {
        const stream = fs.createReadStream(produced);
        const stopStream = () => stream.destroy();
        controller.signal.addEventListener("abort", stopStream, { once: true });
        stream.once("close", () => { controller.signal.removeEventListener("abort", stopStream); resolve(); });
        stream.once("error", (error) => {
          console.error("download read failed:", error);
          if (!res.headersSent) {
            res.removeHeader("Content-Length");
            res.removeHeader("Content-Disposition");
            sendDownloadError(res, classifyDownloadError("audio read failed"));
          } else res.destroy();
        });
        stream.pipe(res);
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("download request failed:", error);
        sendDownloadError(res, classifyDownloadError("", { error }));
      }
    } finally {
      // All tool/probe/stream handles are closed before deletion or slot release.
      if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (error) { console.warn("download cleanup failed:", error.message); } }
      activeWorkDirs.delete(workDir);
      activeControllers.delete(controller);
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
      release();
    }
  }, () => stopWaiting("service_restarting", "The download service is restarting."));
  if (!queuedJob) {
    req.removeListener("aborted", abort);
    res.removeListener("close", abort);
    return sendDownloadError(res, { status: 503, code: shuttingDown ? "service_restarting" : "queue_full", category: "queue-full",
      message: shuttingDown ? "The download service is restarting." : "The download queue is full right now.",
      hint: "Please try again in a moment.", retryable: true, retryAfterSeconds: 3 });
  }
  if (!started) queueTimer = setTimeout(() => stopWaiting("queue_timeout", "The download queue is taking longer than expected."), DOWNLOAD_QUEUE_TIMEOUT_S * 1000);
});

// Tool health — visit https://<your-api>/diag in a browser to confirm yt-dlp and
// ffmpeg are actually runnable by the app. If ffmpeg.ok is false, EVERY download
// will 500 (all formats need ffmpeg); if yt-dlp.ok is false, nothing downloads.
app.get("/diag", (req, res) => {
  const out = {
    version: BACKEND_VERSION,
    ytdlp: null,
    ffmpeg: null,
    ffprobe: null,
    ffmpegPath: ffmpegProbePath(),
    ffprobePath: ffprobeProbePath(),
    ytdlpPath: YTDLP_BIN,
    uptimeSeconds: Math.floor(process.uptime()),
    // Region-recovery status: confirm the proxy/geo-bypass you configured is live.
    region: { proxy: SOUNDCLOUD_PROXY ? "configured" : "none", geoBypass: GEO_BYPASS_OFF ? "off" : (GEO_BYPASS_COUNTRY || "auto"), previewFallback: true, auth: SOUNDCLOUD_COOKIE_FILE ? (SOUNDCLOUD_COOKIES ? "cookies" : "oauth") : "none" },
    downloads: { active: activeJobs, queued: jobQueue.length, concurrency: MAX_CONCURRENT, queueLimit: MAX_QUEUE, attempts: DOWNLOAD_ATTEMPTS, queueTimeoutSeconds: DOWNLOAD_QUEUE_TIMEOUT_S, shuttingDown },
    converter: convertRouter.getStatus(),
    memory: process.memoryUsage(),
  };
  let pending = 3;
  const done = () => { if (--pending === 0) res.json(out); };
  toolVersion(YTDLP_BIN, ["--version"], (r) => { out.ytdlp = r; done(); });
  toolVersion(ffmpegProbePath(), ["-version"], (r) => { out.ffmpeg = r; done(); });
  toolVersion(ffprobeProbePath(), ["-version"], (r) => { out.ffprobe = r; done(); });
});

// ── Temp-file sweeper ─────────────────────────────────────────────────────────
// Every download/convert job deletes its own temp files on completion, but a
// crash, SIGKILL, per-job timeout or an aborted browser upload can still strand
// orphans in os.tmpdir(); left alone they slowly fill the VPS disk. This periodic
// sweep removes only OUR temp files/dirs (known "trackgrab-"/"scloud" prefixes)
// once they are older than TEMP_MAX_AGE_MIN — comfortably longer than the longest
// job (download 900s / convert 600s), so a file that is still being written is
// never reaped (its mtime keeps it fresh). The yt-dlp cache dir is intentionally
// NOT matched, so cached client_id/extractor data survives.
const TEMP_DIR = os.tmpdir();
const TEMP_PREFIXES = ["trackgrab-", "scloud"];
const TEMP_MAX_AGE_MS = Math.max(15, parseInt(process.env.TEMP_MAX_AGE_MIN || "60", 10) || 60) * 60 * 1000;
const TEMP_SWEEP_MS = Math.max(1, parseInt(process.env.TEMP_SWEEP_INTERVAL_MIN || "15", 10) || 15) * 60 * 1000;

function sweepTempOnce() {
  let entries;
  try { entries = fs.readdirSync(TEMP_DIR); } catch (e) { return; }
  const cutoff = Date.now() - TEMP_MAX_AGE_MS;
  let removed = 0;
  for (const name of entries) {
    if (!TEMP_PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = path.join(TEMP_DIR, name);
    if (activeWorkDirs.has(full)) continue;
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    // mtime is updated while a job is actively writing the file, so anything whose
    // mtime is older than the (generous) cutoff is a finished/abandoned orphan —
    // the longest job is ~15 min, well under the 60 min default.
    if (st.mtimeMs > cutoff) continue;
    try {
      if (st.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else fs.unlinkSync(full);
      removed++;
    } catch (e) {}
  }
  if (removed) {
    console.log(`[sweep] removed ${removed} stale temp item(s) older than ${Math.round(TEMP_MAX_AGE_MS / 60000)}m`);
  }
}

function startTempSweeper() {
  try { sweepTempOnce(); } catch (e) {}
  const timer = setInterval(() => { try { sweepTempOnce(); } catch (e) {} }, TEMP_SWEEP_MS);
  timer.unref(); // never keep the process alive just for the sweep
  console.log(`✓ temp sweeper active (every ${Math.round(TEMP_SWEEP_MS / 60000)}m, max age ${Math.round(TEMP_MAX_AGE_MS / 60000)}m)`);
}

// Log tool availability at boot so a missing yt-dlp/ffmpeg is obvious in pm2 logs.
function selfCheck() {
  toolVersion(YTDLP_BIN, ["--version"], (r) =>
    console.log(r.ok ? `✓ yt-dlp ${r.version}` : `✗ yt-dlp NOT RUNNABLE (${r.error}) — install it or set YTDLP_PATH; downloads will fail`));
  const ff = ffmpegProbePath();
  toolVersion(ff, ["-version"], (r) =>
    console.log(r.ok ? `✓ ${r.version}` : `✗ ffmpeg NOT RUNNABLE at "${ff}" (${r.error}) — install ffmpeg/ffprobe or set FFMPEG_LOCATION; ALL downloads will 500`));
  toolVersion(ffprobeProbePath(), ["-version"], (r) =>
    console.log(r.ok ? `✓ ${r.version}` : `✗ ffprobe NOT RUNNABLE (${r.error}) — downloads cannot be verified`));
}

const PORT = process.env.PORT || 3001;
let server = null;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; draining active requests before exit`);
  // Reject queued work so a restart only waits for already-running jobs.
  for (const job of [...jobQueue]) job.cancel?.();
  if (!server) return;
  server.close(() => process.exit(0));
  setTimeout(() => {
    for (const controller of activeControllers) controller.abort();
    setTimeout(() => process.exit(1), 1000).unref();
  }, SHUTDOWN_GRACE_S * 1000).unref();
}
if (require.main === module) {
  server = app.listen(PORT, () => {
    console.log(`TrackGrab ${BACKEND_VERSION} server running on port ${PORT}`);
    selfCheck();
    startTempSweeper();
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
module.exports = { app, server, shutdown };
