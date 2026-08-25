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
 *     CONVERT_CONCURRENCY simultaneous conversions, default 2
 *     CONVERT_TIMEOUT_S   per-job timeout seconds, default 600
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
const MAX_MB = parseInt(process.env.CONVERT_MAX_MB || "500", 10);
const MAX_CONCURRENCY = parseInt(process.env.CONVERT_CONCURRENCY || "2", 10);
const TIMEOUT_S = parseInt(process.env.CONVERT_TIMEOUT_S || "600", 10);

// "-threads 0" lets ffmpeg use every core (helps FLAC and the muxing/decode path);
// m4a gets "+faststart" so the moov atom is at the front and the file is usable /
// streamable the instant it lands on the device.
const FORMATS = {
  mp3: { ext: "mp3", args: (q) => ["-vn", "-map_metadata", "-1", "-threads", "0", "-c:a", "libmp3lame", "-b:a", `${q}k`] },
  m4a: { ext: "m4a", args: (q) => ["-vn", "-map_metadata", "-1", "-threads", "0", "-c:a", "aac", "-b:a", `${q}k`, "-movflags", "+faststart"] },
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
  let output = null;
  const fail = (code, msg) => { unlink(input); unlink(output); if (!res.headersSent) res.status(code).json({ error: msg }); };

  if (!secretOk(req)) return fail(401, "unauthorized");
  if (!input) return fail(400, "no_file");

  const format = String(req.body.format || "").toLowerCase();
  const quality = Math.min(320, Math.max(64, parseInt(req.body.quality || "192", 10) || 192));
  const exp = req.body.exp, sig = req.body.sig;
  if (!FORMATS[format]) return fail(400, "bad_format");
  if (!validSig(`${format}|${quality}|${exp}`, exp, sig)) return fail(403, "bad_signature");
  if (active >= MAX_CONCURRENCY) return fail(503, "busy");

  active++;
  const spec = FORMATS[format];
  output = path.join(os.tmpdir(), `scloud_${crypto.randomBytes(8).toString("hex")}.${spec.ext}`);
  const ff = spawn(FFMPEG, ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-i", input, ...spec.args(quality), output]);
  let err = "";
  ff.stderr.on("data", (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
  const timer = setTimeout(() => ff.kill("SIGKILL"), TIMEOUT_S * 1000);

  ff.on("error", () => { clearTimeout(timer); active--; fail(500, "ffmpeg_spawn_failed"); });
  ff.on("close", (code) => {
    clearTimeout(timer);
    active--;
    if (code !== 0 || !fs.existsSync(output) || fs.statSync(output).size === 0) {
      console.error("[convert] ffmpeg failed:", err.slice(-500));
      return fail(500, "conversion_failed");
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="converted.${spec.ext}"`);
    const stream = fs.createReadStream(output);
    stream.on("close", () => { unlink(input); unlink(output); });
    stream.on("error", () => fail(500, "stream_failed"));
    stream.pipe(res);
  });
});

/* -------- POST /convert-direct : browser uploads straight here -------- */
/* The browser sends the file + a WordPress-signed ticket. Nothing passes through
   the (shared/slow) WordPress host, so this is the fast path. CORS is provided by
   the global cors() in server.js; a plain multipart POST needs no preflight. */
router.post("/convert-direct", upload.single("file"), async (req, res) => {
  const input = req.file ? req.file.path : null;
  let output = null;
  const fail = (code, msg) => { unlink(input); unlink(output); if (!res.headersSent) res.status(code).json({ error: msg }); };

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

  active++;
  const spec = FORMATS[format];
  output = path.join(os.tmpdir(), `scloudd_${crypto.randomBytes(8).toString("hex")}.${spec.ext}`);
  const ff = spawn(FFMPEG, ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-i", input, ...spec.args(quality), output]);
  let err = "";
  ff.stderr.on("data", (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
  const timer = setTimeout(() => ff.kill("SIGKILL"), TIMEOUT_S * 1000);

  ff.on("error", () => { clearTimeout(timer); active--; fail(500, "ffmpeg_spawn_failed"); });
  ff.on("close", (code) => {
    clearTimeout(timer);
    active--;
    if (code !== 0 || !fs.existsSync(output) || fs.statSync(output).size === 0) {
      console.error("[convert-direct] ffmpeg failed:", err.slice(-500));
      return fail(500, "conversion_failed");
    }
    const outName = safeOutName(req.body.name, spec.ext);
    res.setHeader("Content-Type", DIRECT_MIME[format] || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${outName}"; filename*=UTF-8''${encodeURIComponent(outName)}`);
    try { res.setHeader("Content-Length", fs.statSync(output).size); } catch (e) {}
    const stream = fs.createReadStream(output);
    stream.on("close", () => { unlink(input); unlink(output); });
    stream.on("error", () => fail(500, "stream_failed"));
    stream.pipe(res);
  });
});

router.use((e, _req, res, _next) => {
  if (e && e.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "file_too_large" });
  res.status(500).json({ error: "server_error" });
});

module.exports = router;
