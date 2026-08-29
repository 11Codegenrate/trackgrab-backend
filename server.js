const express = require("express");
const cors = require("cors");
const { execFile, spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const app = express();

// Expose the download headers to cross-origin browser JS. The WordPress tool page
// and this API are different origins, so without this the in-page downloader can't
// read the server's real filename or size — which is what lets iOS/Android save the
// file under the correct name and extension instead of a generic "download".
app.use(
  cors({
    exposedHeaders: ["Content-Disposition", "Content-Length", "Accept-Ranges"],
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
  const turl = e.url || e.webpage_url || "";
  return {
    title: e.title || titleFromUrl(turl),
    url: turl,
    uploader: e.uploader || "",
    duration: typeof e.duration === "number" ? e.duration : null,
    thumbnail: bestThumb(e),
  };
}

// Get track info, or a playlist. One yt-dlp call: --flat-playlist means a
// /sets/ URL returns the playlist with a lightweight entries[] list (1 request
// to SoundCloud) instead of resolving all 50 tracks (which gets rate-limited).
// A single-track URL returns its full metadata (flat-playlist is a no-op there).
app.get("/info", (req, res) => {
  if (!apiKeyOk(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const url = req.query.url;
  if (!url || typeof url !== "string" || !url.includes("soundcloud.com")) {
    return res.status(400).json({ error: "Invalid SoundCloud URL" });
  }

  // execFile (not exec): pass the URL as a real argv entry so the shell never
  // parses it. The previous exec("...\"${url}\"...") interpolated a user-supplied
  // string into a shell command line — a `"` in the URL broke out of the quotes
  // and allowed command injection. Array args close that off with no behaviour
  // change for legitimate URLs.
  execFile(
    YTDLP_BIN,
    ["-J", "--flat-playlist", "--no-playlist", "--no-warnings", "--cache-dir", YTDLP_CACHE_DIR, url],
    { timeout: 45000, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        console.error("yt-dlp info error:", stderr);
        return res.status(500).json({ error: "Could not fetch track info" });
      }

      let meta;
      try {
        meta = JSON.parse(stdout);
      } catch (e) {
        return res.status(500).json({ error: "Failed to parse track data" });
      }
      if (!meta) {
        return res.status(500).json({ error: "No track data" });
      }

      // Playlist / set.
      if (Array.isArray(meta.entries)) {
        const tracks = meta.entries
          .filter((e) => e && (e.url || e.webpage_url))
          .map(flatTrackShape);
        return res.json({
          type: "playlist",
          header: {
            playlist_title: meta.title || meta.album || "Playlist",
            uploader: meta.uploader || meta.album_artist || "",
            uploader_url: meta.uploader_url || "",
            thumbnail: bestThumb(meta),
          },
          total: meta.playlist_count || tracks.length,
          tracks: tracks,
        });
      }

      // Single track — original response shape (unchanged).
      res.json({
        title: meta.title,
        uploader: meta.uploader,
        thumbnail: meta.thumbnail,
        duration: meta.duration,
        description: meta.description,
        like_count: meta.like_count,
        view_count: meta.view_count,
        url: url,
      });
    }
  );
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

// Build the yt-dlp argument list for a format + plan-derived options.
// - bitrate: lossy formats encode CBR at "<bitrate>K"; lossless ignore it.
// - meta: embed title/artist/etc. tags and cover art (where the container supports it).
function buildYtdlpArgs(fmt, opts) {
  const args = ["-x", "--audio-format", fmt.audioFormat];

  if (!fmt.lossless) {
    // "<n>K" tells ffmpeg to target that exact bitrate; "0" = best VBR.
    args.push("--audio-quality", opts.bitrate ? `${opts.bitrate}K` : "0");
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

// Turn a failed yt-dlp/ffmpeg run into a specific, actionable reason. The full
// stderr is logged server-side; this is the short, safe version the browser shows,
// so a failed download stops being a mystery "Something went wrong".
function classifyDownloadError(stderr) {
  const s = String(stderr || "");
  const low = s.toLowerCase();
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const detail = lines.length ? lines[lines.length - 1].slice(0, 300) : "";
  const has = (re) => re.test(low);

  if (
    has(/ffmpeg (is )?not (installed|found)/) || has(/ffprobe/) || has(/postprocessing/) ||
    has(/you have requested.*but ffmpeg/) || has(/preferred audio format/) || has(/ffmpeg-location/)
  ) {
    return {
      category: "ffmpeg",
      message: "The server's audio converter (ffmpeg) is missing or failed.",
      hint: "Install ffmpeg + ffprobe on the server and make sure they're on the PATH the app runs with (or set FFMPEG_LOCATION). Every download needs ffmpeg — that's why all formats fail.",
      detail,
    };
  }
  if (has(/\bgo\+\b/) || has(/premium/) || has(/snippet/) || has(/preview/) || has(/purchase|subscri/)) {
    return {
      category: "unavailable",
      message: "This track can't be downloaded (looks like SoundCloud Go+ / preview-only).",
      hint: "Only fully public, free-to-stream tracks can be downloaded. Try another track.",
      detail,
    };
  }
  if (has(/private/) || has(/\b403\b/) || has(/forbidden/) || has(/unauthoriz/) || has(/\bsign in\b|\blog ?in\b/)) {
    return {
      category: "private",
      message: "This track is private or blocked, so it can't be downloaded.",
      hint: "Make sure the track is public. Private or blocked tracks can't be fetched.",
      detail,
    };
  }
  if (has(/not available in your country|geo-?block|region/)) {
    return {
      category: "geo",
      message: "This track is region-blocked from the server's location.",
      hint: "It isn't available where the server is hosted.",
      detail,
    };
  }
  if (has(/http error 429|too many requests|rate.?limit/)) {
    return {
      category: "ratelimit",
      message: "SoundCloud is rate-limiting the server right now.",
      hint: "Wait a minute and try again; if it's constant, lower MAX_CONCURRENT.",
      detail,
    };
  }
  if (
    has(/unable to extract/) || has(/unable to download (webpage|json)/) || has(/unsupported url/) ||
    has(/nonetype/) || has(/no video formats|no audio/) || has(/failed to parse json|unable to parse/)
  ) {
    return {
      category: "extractor",
      message: "The downloader couldn't read this track — it's probably out of date.",
      hint: "SoundCloud changes its API often. Update yt-dlp on the server (yt-dlp -U or pip install -U yt-dlp), then restart the app and try again.",
      detail,
    };
  }
  return {
    category: "unknown",
    message: "The server couldn't produce this file.",
    hint: "Check the server logs (pm2 logs trackgrab) for the yt-dlp / ffmpeg error. Most often it's an out-of-date yt-dlp (yt-dlp -U) or a missing ffmpeg.",
    detail,
  };
}

// Run "<tool> <versionArgs>" and report whether it's actually runnable. Used by
// the startup self-check and /diag so a missing yt-dlp/ffmpeg is obvious.
function toolVersion(cmd, args, cb) {
  execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
    if (err) return cb({ ok: false, error: (err && err.code) || String(err.message || err).slice(0, 140) });
    cb({ ok: true, version: String(stdout || stderr).split(/\r?\n/)[0].slice(0, 140) });
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
function verifyDownloadedOutput(input, requested) {
  return new Promise((resolve) => {
    const pf = spawn(ffprobeProbePath(), [
      "-v", "error",
      "-show_entries", "format=format_name:stream=codec_name,codec_type",
      "-of", "json",
      input,
    ]);
    let out = "";
    pf.stdout.on("data", (d) => { out += d.toString(); if (out.length > 20000) out = out.slice(-20000); });
    pf.on("error", (e) => resolve({ ok: false, detail: e.code || e.message || "ffprobe_failed" }));
    pf.on("close", () => {
      try {
        const data = JSON.parse(out);
        const container = String(data?.format?.format_name || "").toLowerCase();
        const codecs = (Array.isArray(data?.streams) ? data.streams : [])
          .filter((s) => s?.codec_type === "audio")
          .map((s) => String(s.codec_name || "").toLowerCase());
        const ok =
          (requested === "mp3" && container.includes("mp3") && codecs.includes("mp3")) ||
          ((requested === "m4a" || requested === "mp4") && /mov|mp4|m4a/.test(container) && codecs.includes("aac")) ||
          (requested === "wav" && container.includes("wav") && codecs.some((c) => c.startsWith("pcm_"))) ||
          (requested === "flac" && container.includes("flac") && codecs.includes("flac"));
        resolve({ ok, detail: `container=${container || "?"}; codecs=${codecs.join(",") || "?"}` });
      } catch (e) {
        resolve({ ok: false, detail: "invalid_ffprobe_output" });
      }
    });
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
const YTDLP_FRAGMENTS = Math.max(1, parseInt(process.env.YTDLP_FRAGMENTS || "4", 10) || 4);
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
      job.run(release);
    } catch (e) {
      console.error("job run error:", e);
      release();
    }
  }
}

function scheduleJob(priority, run) {
  if (activeJobs >= MAX_CONCURRENT && jobQueue.length >= MAX_QUEUE) return false;
  const job = { priority: priority ? 1 : 0, run };
  if (job.priority) {
    // Insert ahead of all normal jobs, behind any waiting priority jobs (FIFO within a tier).
    let i = 0;
    while (i < jobQueue.length && jobQueue[i].priority >= job.priority) i++;
    jobQueue.splice(i, 0, job);
  } else {
    jobQueue.push(job);
  }
  pumpQueue();
  return true;
}

// Download in the requested audio format.
// yt-dlp's format conversion is a post-processor that needs a real file to work
// on — piping to stdout (-o -) skips it and streams SoundCloud's raw source
// (usually M4A) instead. So we convert to a temp file, stream it, then delete it.
app.get("/download", (req, res) => {
  const url = req.query.url;
  const title = req.query.title || "track";
  const requested = String(req.query.format || "mp3").toLowerCase();
  const fmt = DOWNLOAD_FORMATS[requested];

  if (!fmt) {
    return res.status(400).json({ error: "Unsupported output format" });
  }

  // Plan-derived options passed by the WP plugin's signed URL.
  const opts = {
    bitrate: normalizeBitrate(req.query.bitrate),
    meta: String(req.query.meta || "") === "1",
  };
  // Only V2 signatures cover this flag. Ignoring it on legacy links closes the
  // old append-`priority=1` entitlement bypass while allowing a rolling deploy.
  const priority = String(req.query.v || "") === "2" && String(req.query.priority || "") === "1";

  const sigCheck = downloadSigCheck(req.query);
  if (!sigCheck.ok) {
    // Same message to the browser (the frontend auto-retries a fresh link on this),
    // but log the real reason so a genuine misconfig is visible in the server log:
    //   badsig  → the WordPress "Shared API secret" does not match this box's secret
    //   expired → clock skew beyond SIG_LEEWAY_S, or a genuinely stale/reused link
    //   missing → the link was built without a signature (secret unset on WP side)
    console.warn(
      `[sig] rejected /download reason=${sigCheck.reason} title=${JSON.stringify(
        String(req.query.title || "").slice(0, 60)
      )} exp=${req.query.exp || ""} now=${Math.floor(Date.now() / 1000)}`
    );
    // A code lets the frontend tell "refresh the link and retry" apart from a real
    // problem, without parsing the human message.
    return res
      .status(403)
      .json({ error: "Invalid or expired download link", code: "bad_link", reason: sigCheck.reason });
  }
  if (!url || !url.includes("soundcloud.com")) {
    return res.status(400).json({ error: "Invalid SoundCloud URL" });
  }

  const safeTitle = title.replace(/[^a-zA-Z0-9_\- ]/g, "").trim() || "track";
  const workId = crypto.randomBytes(8).toString("hex");
  const prefix = `trackgrab-${workId}`;
  const outTemplate = path.join(os.tmpdir(), `${prefix}.%(ext)s`);

  function cleanup() {
    try {
      const dir = os.tmpdir();
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(prefix)) {
          try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  const accepted = scheduleJob(priority, (release) => {
    // Client already gone before the slot opened — drop the job.
    if (res.writableEnded || req.destroyed) {
      cleanup();
      release();
      return;
    }

    // Free the queue slot exactly once, whenever this response is fully done.
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      release();
    };
    res.on("finish", releaseSlot);
    res.on("close", releaseSlot);

    const ytdlp = spawn(YTDLP_BIN, [
      ...buildYtdlpArgs(fmt, opts),
      // Speed: SoundCloud audio is delivered as many small HLS fragments. Pulling
      // them in parallel (instead of one-at-a-time) is the single biggest win on
      // download latency. Retries keep a flaky fragment from failing the whole job.
      "--concurrent-fragments", String(YTDLP_FRAGMENTS),
      "--retries", "3",
      "--fragment-retries", "5",
      // Speed: reuse the cached SoundCloud client_id / extractor data instead of
      // re-resolving it on every single download (one fewer network round-trip per job).
      "--cache-dir", YTDLP_CACHE_DIR,
      // Speed: let ffmpeg's post-processing (encode/mux) use every available core.
      // No effect on single-threaded codecs (mp3), a real win on flac/wav/aac.
      "--postprocessor-args", "ffmpeg:-threads 0",
      // Point yt-dlp at a bundled ffmpeg when one is provided (container builds);
      // empty by default so system-PATH ffmpeg keeps working on existing installs.
      ...(FFMPEG_LOCATION ? ["--ffmpeg-location", FFMPEG_LOCATION] : []),
      "--no-mtime",
      "-o", outTemplate,
      "--no-playlist",
      "--no-progress",
      url,
    ]);

    let stderr = "";
    let timedOut = false;
    ytdlp.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 65536) stderr = stderr.slice(-65536);
    });
    const jobTimer = setTimeout(() => {
      timedOut = true;
      if (ytdlp.exitCode === null) ytdlp.kill("SIGKILL");
    }, DOWNLOAD_TIMEOUT_S * 1000);

    ytdlp.on("error", (err) => {
      clearTimeout(jobTimer);
      console.error("spawn error:", err);
      cleanup();
      if (!res.headersSent) {
        if (err && err.code === "ENOENT") {
          res.status(500).json({
            error: "Download failed",
            category: "ytdlp-missing",
            message: "The downloader (yt-dlp) isn't installed or isn't on the server's PATH.",
            hint: "Install yt-dlp on the server (or set YTDLP_PATH to its full path) and restart the app.",
          });
        } else {
          res.status(500).json({
            error: "Download failed",
            category: "spawn",
            message: "The server couldn't start the download process.",
            hint: "Check the server logs (pm2 logs trackgrab).",
          });
        }
      }
      releaseSlot();
    });

    ytdlp.on("close", async (code) => {
      clearTimeout(jobTimer);
      // Find the finished AUDIO yt-dlp produced. This must never pick the embedded
      // cover-art image (yt-dlp leaves a prefix.jpg/.webp beside the audio when
      // --embed-thumbnail is used) or an in-progress ".part" fragment. The old code
      // fell back to "first non-.part file", which for the mp4 format — whose target
      // extension (.mp4) differs from the encoder's real output (.m4a) — could hand
      // back the .jpg thumbnail and serve an image as the track. Pick by real audio
      // extension only: exact requested ext, then the encoder ext. Never fall back
      // to an arbitrary source stream, because that would create a false extension.
      let produced = null;
      try {
        const dir = os.tmpdir();
        const base = prefix + ".";
        const extOf = (f) => f.slice(base.length).toLowerCase();
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.startsWith(base) && !f.endsWith(".part"));
        const pick =
          files.find((f) => extOf(f) === fmt.ext) ||         // requested ext (mp3/m4a/wav/flac)
          files.find((f) => extOf(f) === fmt.audioFormat);   // encoder ext (mp4 -> m4a)
        if (pick) produced = path.join(dir, pick);
      } catch (e) {}

      if (timedOut) {
        console.error(`yt-dlp timed out after ${DOWNLOAD_TIMEOUT_S}s for ${url}`);
        cleanup();
        if (!res.headersSent) {
          res.status(504).json({
            error: "Download timed out",
            category: "timeout",
            message: "The server took too long to build this file.",
            hint: "Try again once. If this repeats, lower concurrency or inspect the VPS network and SoundCloud rate limits.",
          });
        }
        releaseSlot();
        return;
      }

      // No finished audio at all → genuine conversion failure. Classify the reason
      // so the browser can show what actually went wrong (ffmpeg missing, stale
      // yt-dlp, private/Go+ track, …) instead of a blank "Something went wrong".
      if (!produced) {
        console.error("yt-dlp failed (code " + code + "), no output. stderr:\n" + stderr);
        const info = classifyDownloadError(stderr);
        cleanup();
        if (!res.headersSent) {
          res.status(500).json({
            error: "Conversion failed",
            category: info.category,
            message: info.message,
            hint: info.hint,
            detail: info.detail,
          });
        }
        releaseSlot();
        return;
      }

      // Non-zero exit but the finished file exists → a post-processing step (e.g.
      // cover-art embed) failed after the audio was ready. Serve the audio anyway
      // rather than denying the download over a cosmetic tagging error.
      if (code !== 0) {
        console.warn("yt-dlp exited " + code + " but output exists; serving anyway. stderr:", stderr);
      }

      const verified = await verifyDownloadedOutput(produced, requested);
      if (!verified.ok) {
        console.error(`yt-dlp produced the wrong format for ${requested}: ${verified.detail}`);
        cleanup();
        if (!res.headersSent) {
          res.status(500).json({
            error: "Wrong output format",
            category: "wrong-output-format",
            message: `The server could not produce a valid ${requested.toUpperCase()} file.`,
            hint: "Check yt-dlp/FFmpeg versions and the VPS logs. The incorrect file was rejected instead of being sent with a false extension.",
          });
        }
        releaseSlot();
        return;
      }

      const safeFile = `${safeTitle}.${fmt.ext}`;
      res.setHeader("Content-Disposition", `attachment; filename="${safeFile}"; filename*=UTF-8''${encodeURIComponent(safeFile)}`);
      res.setHeader("Content-Type", fmt.mime);
      res.setHeader("Accept-Ranges", "bytes");
      try {
        res.setHeader("Content-Length", fs.statSync(produced).size);
      } catch (e) {}

      const stream = fs.createReadStream(produced);
      stream.on("error", () => {
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: "Read failed" });
        releaseSlot();
      });
      stream.on("close", cleanup);
      stream.pipe(res);
    });

    // "close" on IncomingMessage can mean the request body merely completed, so
    // using it here could kill healthy GET downloads. Only "aborted" means the
    // request itself was interrupted; response close handles a vanished client.
    req.on("aborted", () => {
      if (ytdlp.exitCode === null) ytdlp.kill();
      cleanup();
      releaseSlot();
    });
    res.on("close", () => {
      if (!res.writableEnded && ytdlp.exitCode === null) ytdlp.kill();
      if (!res.writableEnded) cleanup();
    });
  });
  if (!accepted) {
    return res.status(503).json({
      error: "Server busy",
      category: "queue-full",
      message: "The download queue is full right now.",
      hint: "Please wait a moment and try again.",
    });
  }
});

// Tool health — visit https://<your-api>/diag in a browser to confirm yt-dlp and
// ffmpeg are actually runnable by the app. If ffmpeg.ok is false, EVERY download
// will 500 (all formats need ffmpeg); if yt-dlp.ok is false, nothing downloads.
app.get("/diag", (req, res) => {
  const out = {
    ytdlp: null,
    ffmpeg: null,
    ffmpegPath: ffmpegProbePath(),
    ffprobePath: ffprobeProbePath(),
    ytdlpPath: YTDLP_BIN,
    uptimeSeconds: Math.floor(process.uptime()),
    downloads: { active: activeJobs, queued: jobQueue.length, concurrency: MAX_CONCURRENT, queueLimit: MAX_QUEUE },
    converter: convertRouter.getStatus(),
    memory: process.memoryUsage(),
  };
  let pending = 2;
  const done = () => { if (--pending === 0) res.json(out); };
  toolVersion(YTDLP_BIN, ["--version"], (r) => { out.ytdlp = r; done(); });
  toolVersion(ffmpegProbePath(), ["-version"], (r) => { out.ffmpeg = r; done(); });
});

// Log tool availability at boot so a missing yt-dlp/ffmpeg is obvious in pm2 logs.
function selfCheck() {
  toolVersion(YTDLP_BIN, ["--version"], (r) =>
    console.log(r.ok ? `✓ yt-dlp ${r.version}` : `✗ yt-dlp NOT RUNNABLE (${r.error}) — install it or set YTDLP_PATH; downloads will fail`));
  const ff = ffmpegProbePath();
  toolVersion(ff, ["-version"], (r) =>
    console.log(r.ok ? `✓ ${r.version}` : `✗ ffmpeg NOT RUNNABLE at "${ff}" (${r.error}) — install ffmpeg/ffprobe or set FFMPEG_LOCATION; ALL downloads will 500`));
}

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`TrackGrab server running on port ${PORT}`);
  selfCheck();
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; draining active requests before exit`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 12000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
