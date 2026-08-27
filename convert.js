/**
 * convert.js — audio conversion routes for trackgrab-backend.
 *
 * Mounts two endpoints the WordPress SCloud Audio Converter calls instead of
 * running ffmpeg on the (shared) WP host:
 *   POST /probe    -> { source, duration }  (ffprobe: validate + get duration)
 *   POST /convert  -> streams the converted audio file back
 *
 * FFmpeg/ffprobe already live on this VPS (yt-dlp uses them). Reuses trackgrab's
 * domain, nginx and PM2 — deploy via the normal `git pull && pm2 restart trackgrab`.
 *
 * Integrate in your main app file (e.g. server.js/index.js):
 *     app.use(require('./convert'));
 *
 * Env (add to your PM2 ecosystem / .env):
 *     CONVERT_SECRET      shared secret; paste the SAME value into WordPress  (REQUIRED)
 *     FFMPEG_PATH         default "ffmpeg"
 *     FFPROBE_PATH        default "ffprobe"
 *     CONVERT_MAX_MB      max input size, default 500
 *     CONVERT_CONCURRENCY simultaneous conversions, default 1
 *     CONVERT_TIMEOUT_S   per-job timeout seconds, default 600
 *     M4A_BITRATE         AAC bitrate, default 128 (kept independent of MP3)
 */

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SECRET = process.env.CONVERT_SECRET || "";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const MAX_MB = Math.max(1, parseInt(process.env.CONVERT_MAX_MB || "500", 10) || 500);
// Downloader jobs have their own bounded pool. One conversion at a time keeps
// the combined yt-dlp + converter load inside a small VPS's CPU/RAM envelope.
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.CONVERT_CONCURRENCY || "1", 10) || 1);
const TIMEOUT_S = Math.max(30, parseInt(process.env.CONVERT_TIMEOUT_S || "600", 10) || 600);
const M4A_BITRATE = Math.min(192, Math.max(64, parseInt(process.env.M4A_BITRATE || "128", 10) || 128));

// "-threads 0" lets ffmpeg use every core (helps FLAC and the muxing/decode path);
// m4a gets "+faststart" so the moov atom is at the front and the file is usable /
// streamable the instant it lands on the device.
const FORMATS = {
  mp3: { ext: "mp3", args: (q) => ["-vn", "-map_metadata", "-1", "-threads", "0", "-c:a", "libmp3lame", "-b:a", `${q}k`] },
  // M4A is intentionally independent of the UI's MP3 quality control. 128 kbps
  // AAC is comparable in size to common online converters without wasting bytes.
  m4a: { ext: "m4a", args: () => ["-vn", "-map_metadata", "-1", "-threads", "0", "-c:a", "aac", "-b:a", `${M4A_BITRATE}k`, "-movflags", "+faststart"] },
  wav: { ext: "wav", args: () => ["-vn", "-map_metadata", "-1", "-threads", "0", "-c:a", "pcm_s16le"] },
  flac: { ext: "flac", args: () => ["-vn", "-map_metadata", "-1", "-threads", "0", "-c:a", "flac"] },
};

const router = express.Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });
let active = 0;

const unlink = (p) => p && fs.promises.unlink(p).catch(() => {});

function validSig(payload, exp, sig) {
  if (!SECRET || !sig || !exp) return false;
  if (Date.now() / 1000 > Number(exp)) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const secretOk = (req) => SECRET && (req.get("x-convert-secret") || "") === SECRET;

// Real audio MIME per output format — sent on the direct response so iOS saves a
// proper .mp3/.m4a/.wav/.flac instead of a generic ".bin".
const DIRECT_MIME = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac" };

// Signature for a browser-issued direct ticket. Mirrors the WordPress payload
// exactly: direct|<format>|<quality>|<maxmb>|<maxdur>|<exp>. Because the size and
// duration caps are inside the signed payload, the browser cannot raise them.
function validDirectSig(format, quality, maxmb, maxdur, exp, sig) {
  if (!SECRET || !sig || !exp) return false;
  if (Date.now() / 1000 > Number(exp)) return false;
  const payload = `direct|${format}|${quality}|${maxmb}|${maxdur}|${exp}`;
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ffprobe the input duration (seconds); resolves 0 when it can't be read.
function probeDuration(input) {
  return new Promise((resolve) => {
    const pf = spawn(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "json", input]);
    let out = "";
    pf.stdout.on("data", (d) => (out += d.toString()));
    pf.on("error", () => resolve(0));
    pf.on("close", () => {
      try { resolve(parseFloat(JSON.parse(out)?.format?.duration || "0") || 0); }
      catch (e) { resolve(0); }
    });
  });
}

// Clean a client-supplied filename down to a safe "<base>.<ext>".
function safeOutName(name, ext) {
  const base = String(name || "converted").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9 _.-]/g, "").trim() || "converted";
  return base + "." + ext;
}

// Confirm the bytes match the requested container and codec before serving them.
// A non-empty file is not sufficient: interrupted post-processing can leave the
// original source behind, which previously could be downloaded under a false
// extension.
function verifyOutput(input, format) {
  return new Promise((resolve) => {
    const pf = spawn(FFPROBE, [
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
        const audio = (Array.isArray(data?.streams) ? data.streams : []).filter((s) => s?.codec_type === "audio");
        const codecs = audio.map((s) => String(s.codec_name || "").toLowerCase());
        const noNonAudio = (Array.isArray(data?.streams) ? data.streams : []).every((s) => s?.codec_type === "audio");
        const ok = noNonAudio && audio.length > 0 && (
          (format === "mp3" && container.includes("mp3") && codecs.includes("mp3")) ||
          (format === "m4a" && /mov|mp4|m4a/.test(container) && codecs.includes("aac")) ||
          (format === "wav" && container.includes("wav") && codecs.every((c) => c.startsWith("pcm_"))) ||
          (format === "flac" && container.includes("flac") && codecs.includes("flac"))
        );
        resolve({ ok, detail: `container=${container || "?"}; codecs=${codecs.join(",") || "?"}` });
      } catch (e) {
        resolve({ ok: false, detail: "invalid_ffprobe_output" });
      }
    });
  });
}

/** Run one bounded FFmpeg job, validate it, then stream it with correct headers. */
function convertAndSend(req, res, { input, format, quality, prefix, name }) {
  const spec = FORMATS[format];
  const output = path.join(os.tmpdir(), `${prefix}_${crypto.randomBytes(8).toString("hex")}.${spec.ext}`);
  const cleanup = () => { unlink(input); unlink(output); };
  const fail = (code, msg) => {
    cleanup();
    if (!res.headersSent && !res.writableEnded) res.status(code).json({ error: msg });
  };

  active++;
  const ff = spawn(FFMPEG, ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-i", input, ...spec.args(quality), output]);
  let err = "";
  let settled = false;
  let timedOut = false;
  ff.stderr.on("data", (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
  const timer = setTimeout(() => { timedOut = true; ff.kill("SIGKILL"); }, TIMEOUT_S * 1000);

  const finish = async (code, spawnError) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    active = Math.max(0, active - 1);

    if (spawnError) {
      console.error(`[${prefix}] ffmpeg could not start:`, spawnError.code || spawnError.message);
      return fail(500, "ffmpeg_spawn_failed");
    }
    if (timedOut) {
      console.error(`[${prefix}] ffmpeg timed out after ${TIMEOUT_S}s`);
      return fail(504, "conversion_timeout");
    }
    let bytes = 0;
    try { bytes = fs.statSync(output).size; } catch (e) {}
    if (code !== 0 || bytes < 1) {
      console.error(`[${prefix}] ffmpeg failed:`, err.slice(-500));
      return fail(500, "conversion_failed");
    }

    const verified = await verifyOutput(output, format);
    if (!verified.ok) {
      console.error(`[${prefix}] wrong output format for ${format}: ${verified.detail}`);
      return fail(500, "wrong_output_format");
    }
    if (res.writableEnded || res.destroyed) return cleanup();

    const outName = safeOutName(name, spec.ext);
    res.setHeader("Content-Type", DIRECT_MIME[format] || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${outName}"; filename*=UTF-8''${encodeURIComponent(outName)}`);
    res.setHeader("Content-Length", String(bytes));
    const stream = fs.createReadStream(output);
    stream.on("close", cleanup);
    stream.on("error", (e) => {
      console.error(`[${prefix}] response stream failed:`, e.code || e.message);
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: "stream_failed" });
      else res.destroy(e);
    });
    stream.pipe(res);
  };

  ff.once("error", (e) => finish(null, e));
  ff.once("close", (code) => finish(code, null));
  res.once("close", () => {
    if (!res.writableEnded && ff.exitCode === null) ff.kill("SIGKILL");
    if (!res.writableEnded) cleanup();
  });
}

/* -------- POST /probe : validate + duration (ffprobe) -------- */
router.post("/probe", upload.single("file"), (req, res) => {
  const input = req.file ? req.file.path : null;
  const fail = (code, msg) => { unlink(input); if (!res.headersSent) res.status(code).json({ error: msg }); };

  if (!secretOk(req)) return fail(401, "unauthorized");
  if (!input) return fail(400, "no_file");
  const exp = req.body.exp, sig = req.body.sig;
  if (!validSig(`probe|${exp}`, exp, sig)) return fail(403, "bad_signature");

  const pf = spawn(FFPROBE, ["-v", "error", "-show_entries", "format=format_name,duration", "-of", "json", input]);
  let out = "", errout = "";
  pf.stdout.on("data", (d) => (out += d.toString()));
  pf.stderr.on("data", (d) => (errout += d.toString()));
  pf.on("error", (e) => {
    console.error("[probe] ffprobe could not start:", e.code || e.message, "(is ffprobe on PATH?)");
    fail(500, "ffprobe_failed");
  });
  pf.on("close", (code) => {
    unlink(input);
    let data = {};
    try { data = JSON.parse(out); } catch (e) {}
    const fmt = String(data?.format?.format_name || "").toLowerCase();
    const duration = parseFloat(data?.format?.duration || "0") || 0;
    let source = "";
    for (const f of ["mp3", "wav", "flac", "m4a"]) {
      if (fmt.includes(f) || (f === "m4a" && fmt.includes("mov"))) { source = f; break; }
    }
    if (!source || duration <= 0) {
      console.warn(`[probe] unreadable: code=${code} fmt="${fmt}" dur=${duration} stderr=${errout.slice(-300)}`);
    }
    if (!res.headersSent) res.json({ source, duration });
  });
});

/* -------- POST /convert : run ffmpeg, stream result back -------- */
router.post("/convert", upload.single("file"), (req, res) => {
  const input = req.file ? req.file.path : null;
  const fail = (code, msg) => { unlink(input); if (!res.headersSent) res.status(code).json({ error: msg }); };

  if (!secretOk(req)) return fail(401, "unauthorized");
  if (!input) return fail(400, "no_file");

  const format = String(req.body.format || "").toLowerCase();
  const quality = Math.min(320, Math.max(64, parseInt(req.body.quality || "192", 10) || 192));
  const exp = req.body.exp, sig = req.body.sig;
  if (!FORMATS[format]) return fail(400, "bad_format");
  if (!validSig(`${format}|${quality}|${exp}`, exp, sig)) return fail(403, "bad_signature");
  if (active >= MAX_CONCURRENCY) return fail(503, "busy");

  convertAndSend(req, res, { input, format, quality, prefix: "scloud", name: req.body.name || "converted" });
});

/* -------- POST /convert-direct : browser uploads straight here -------- */
/* The browser sends the file + a WordPress-signed ticket. Nothing passes through
   the (shared/slow) WordPress host, so this is the fast path. CORS is provided by
   the global cors() in server.js; a plain multipart POST needs no preflight. */
router.post("/convert-direct", upload.single("file"), async (req, res) => {
  const input = req.file ? req.file.path : null;
  const fail = (code, msg) => { unlink(input); if (!res.headersSent) res.status(code).json({ error: msg }); };

  if (!input) return fail(400, "no_file");

  const format = String(req.body.format || "").toLowerCase();
  const quality = Math.min(320, Math.max(64, parseInt(req.body.quality || "192", 10) || 192));
  const maxmb = parseInt(req.body.maxmb || "0", 10) || 0;
  const maxdur = parseInt(req.body.maxdur || "0", 10) || 0;
  const exp = req.body.exp, sig = req.body.sig;

  if (!FORMATS[format]) return fail(400, "bad_format");
  if (!validDirectSig(format, quality, maxmb, maxdur, exp, sig)) return fail(403, "bad_signature");
  if (maxmb > 0 && req.file.size > maxmb * 1024 * 1024) return fail(413, "file_too_large");
  if (active >= MAX_CONCURRENCY) return fail(503, "busy");

  // Enforce the signed duration cap (plan limit) before spending CPU on convert.
  if (maxdur > 0) {
    const dur = await probeDuration(input);
    if (dur <= 0) return fail(400, "unreadable");
    if (dur > maxdur + 1) return fail(413, "too_long");
  }

  convertAndSend(req, res, { input, format, quality, prefix: "scloudd", name: req.body.name || "converted" });
});

router.get("/convert-health", (_req, res) => {
  const configured = Boolean(SECRET);
  res.status(configured ? 200 : 503).json({
    status: configured ? "ok" : "misconfigured",
    configured,
    active,
    concurrency: MAX_CONCURRENCY,
    m4aBitrateKbps: M4A_BITRATE,
  });
});

router.use((e, _req, res, _next) => {
  if (e && e.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "file_too_large" });
  res.status(500).json({ error: "server_error" });
});

router.getStatus = () => ({
  configured: Boolean(SECRET),
  active,
  concurrency: MAX_CONCURRENCY,
  m4aBitrateKbps: M4A_BITRATE,
});

module.exports = router;
