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

const FORMATS = {
  mp3: { ext: "mp3", args: (q) => ["-vn", "-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", `${q}k`] },
  m4a: { ext: "m4a", args: (q) => ["-vn", "-map_metadata", "-1", "-c:a", "aac", "-b:a", `${q}k`] },
  wav: { ext: "wav", args: () => ["-vn", "-map_metadata", "-1", "-c:a", "pcm_s16le"] },
  flac: { ext: "flac", args: () => ["-vn", "-map_metadata", "-1", "-c:a", "flac"] },
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

/* -------- POST /probe : validate + duration (ffprobe) -------- */
router.post("/probe", upload.single("file"), (req, res) => {
  const input = req.file ? req.file.path : null;
  const fail = (code, msg) => { unlink(input); if (!res.headersSent) res.status(code).json({ error: msg }); };

  if (!secretOk(req)) return fail(401, "unauthorized");
  if (!input) return fail(400, "no_file");
  const exp = req.body.exp, sig = req.body.sig;
  if (!validSig(`probe|${exp}`, exp, sig)) return fail(403, "bad_signature");

  const pf = spawn(FFPROBE, ["-v", "error", "-show_entries", "format=format_name,duration", "-of", "json", input]);
  let out = "";
  pf.stdout.on("data", (d) => (out += d.toString()));
  pf.on("error", () => fail(500, "ffprobe_failed"));
  pf.on("close", () => {
    unlink(input);
    let data = {};
    try { data = JSON.parse(out); } catch (e) {}
    const fmt = String(data?.format?.format_name || "").toLowerCase();
    const duration = parseFloat(data?.format?.duration || "0") || 0;
    let source = "";
    for (const f of ["mp3", "wav", "flac", "m4a"]) {
      if (fmt.includes(f) || (f === "m4a" && fmt.includes("mov"))) { source = f; break; }
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

router.use((e, _req, res, _next) => {
  if (e && e.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "file_too_large" });
  res.status(500).json({ error: "server_error" });
});

module.exports = router;
