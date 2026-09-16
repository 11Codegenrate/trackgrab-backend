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
    exposedHeaders: ["Content-Disposition", "Content-Length", "Accept-Ranges", "Retry-After"],
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

function soundCloudArgs() {
  // Explicitly try every format supported by the extractor. MP3 output does not
  // require an MP3 source; AAC/Opus are converted by FFmpeg. Local yt-dlp config
  // must not force an obsolete format, simulate downloads or enable DRM formats.
  return ["--ignore-config", "--extractor-args", "soundcloud:formats=*", "--socket-timeout", "20", "--cache-dir", YTDLP_CACHE_DIR];
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
      description: meta.description, like_count: meta.like_count, view_count: meta.view_count, url });
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
      let result, produced, info;
      let includeMeta = opts.meta;
      for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
        const attemptDir = path.join(workDir, String(attempt));
        fs.mkdirSync(attemptDir);
        const outTemplate = path.join(attemptDir, "audio.%(ext)s");
        result = await runTool(YTDLP_BIN, [
          ...soundCloudArgs(), ...buildYtdlpArgs(fmt, { ...opts, meta: includeMeta }),
          "--format", "bestaudio[format_id!*=preview]/best[format_id!*=preview]",
          "--concurrent-fragments", String(YTDLP_FRAGMENTS), "--retries", "3", "--fragment-retries", "5",
          "--abort-on-unavailable-fragments", "--postprocessor-args", "ffmpeg:-threads 2",
          ...(extractAudioCbrArgs(fmt, opts) ? ["--postprocessor-args", "ExtractAudio:" + extractAudioCbrArgs(fmt, opts)] : []),
          ...(FFMPEG_LOCATION ? ["--ffmpeg-location", FFMPEG_LOCATION] : []),
          "--no-mtime", "--no-playlist", "--no-progress", "--no-simulate",
          "--print", "after_move:TRACKGRAB_FILE:%(filepath)s", "-o", outTemplate, "--", url,
        ], { signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()) });
        if (result.aborted || controller.signal.aborted || res.destroyed) return;
        if (result.code === 0 && !result.signal && !result.error && !result.timedOut) {
          // Require both yt-dlp's completed post-processing marker and the exact
          // expected file. Never serve a source, thumbnail or interrupted output.
          const completed = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("TRACKGRAB_FILE:")).map((line) => line.slice("TRACKGRAB_FILE:".length));
          const candidates = [...new Set([fmt.audioFormat, fmt.ext])].map((ext) => path.join(attemptDir, `audio.${ext}`));
          produced = candidates.find((file) => completed.some((name) => path.resolve(name) === path.resolve(file)) && fs.existsSync(file) && fs.statSync(file).size > 0);
          if (produced) break;
          info = classifyDownloadError("no audio file was completed");
        } else info = classifyDownloadError(result.stderr, result);
        console.warn(`[download] attempt=${attempt + 1} code=${result.code} signal=${result.signal || "none"} reason=${info.code} ${result.stderr || result.error?.message || ""}`);
        const optionalMetaFailure = includeMeta && result.code === 1 && !result.signal && !result.error && !result.timedOut &&
          /thumbnail|cover art|artwork|embedmetadata|embedthumbnail|metadata.*embed|embed.*metadata/i.test(result.stderr) &&
          !["drm_protected", "geo_restricted", "track_private", "rate_limited", "preview_only"].includes(info.code);
        if (optionalMetaFailure) includeMeta = false;
        if (attempt + 1 >= DOWNLOAD_ATTEMPTS || (!optionalMetaFailure && !info.retryable) || Date.now() >= deadline) {
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
      const safeFile = `${safeTitle}.${fmt.ext}`;
      res.setHeader("Content-Disposition", `attachment; filename="${safeFile}"; filename*=UTF-8''${encodeURIComponent(safeFile)}`);
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
