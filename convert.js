/**
 * convert.js — audio conversion routes for trackgrab-backend.
 *
 * Mounts the endpoints the WordPress SCloud Audio Converter calls instead of
 * running ffmpeg on the (shared) WP host:
 *   POST /probe    -> { source, duration }  (ffprobe: validate + get duration)
 *   POST /convert  -> streams the converted audio file back
 *   POST /convert-direct -> converts a browser-uploaded local file
 *   POST /convert-source -> securely imports and converts a remote source
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
 *     CONVERT_MAX_MB       max INPUT size, default 500
 *     CONVERT_OUTPUT_MAX_MB max GENERATED file size, default 500 (0 = no cap)
 *     CONVERT_CONCURRENCY  simultaneous conversions, default 1
 *     CONVERT_TIMEOUT_S    per-job timeout seconds, default 600
 *     M4A_BITRATE          fallback AAC bitrate when the request omits one, default 192
 *                          (M4A otherwise honours the quality the user selected, up to 320)
 */

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
const http = require("http");
const https = require("https");

// RESILIENCE (same approach as the downloader's SCLOUD_API_SECRET): default to a
// shared built-in secret when CONVERT_SECRET is unset, so a redeploy/restart that
// loses the env var — or an empty "Convert secret" in WordPress — can no longer make
// every conversion fail with "Your session expired". Set your own matching secret on
// BOTH sides for real security. CONVERT_OPEN=1 restores the old open behaviour.
const SHARED_CONVERT_DEFAULT =
  "9f8e7d6c5b4a39281706f5e4d3c2b1a09182736455647382910abcdef01234567";
const SECRET =
  process.env.CONVERT_OPEN === "1"
    ? ""
    : process.env.CONVERT_SECRET || SHARED_CONVERT_DEFAULT;
// Clock-skew grace between the WordPress box (stamps exp) and this box (checks it),
// so a slightly-off VPS clock does not make fresh tickets look already-expired.
const SIG_LEEWAY_S = Math.max(0, parseInt(process.env.CONVERT_SIG_LEEWAY_S || "600", 10) || 600);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const MAX_MB = Math.max(1, parseInt(process.env.CONVERT_MAX_MB || "500", 10) || 500);
// Hard ceiling on the GENERATED file (dev notes §3/§4): a small lossy input can
// explode into a huge WAV (e.g. 80 MB FLAC → 250 MB WAV is fine, but 100 MB
// FLAC → 700 MB WAV must be rejected). Independent of the input cap above.
// 0 disables the check. Kept in sync with the WordPress "Max generated output".
const OUTPUT_MAX_MB = Math.max(0, parseInt(process.env.CONVERT_OUTPUT_MAX_MB || "500", 10) || 0);
// Downloader jobs have their own bounded pool. One conversion at a time keeps
// the combined yt-dlp + converter load inside a small VPS's CPU/RAM envelope.
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.CONVERT_CONCURRENCY || "1", 10) || 1);
const TIMEOUT_S = Math.max(30, parseInt(process.env.CONVERT_TIMEOUT_S || "600", 10) || 600);
const SOURCE_TIMEOUT_S = Math.max(15, parseInt(process.env.CONVERT_SOURCE_TIMEOUT_S || "180", 10) || 180);
const SOURCE_REDIRECTS = Math.min(8, Math.max(0, parseInt(process.env.CONVERT_SOURCE_REDIRECTS || "5", 10) || 5));
// Fallback AAC bitrate when the request doesn't specify one. M4A now honours the
// quality the user picked (up to 320) so the converted file matches the chosen
// button — the old fixed 128 made a "320" selection silently come out at 128.
const M4A_BITRATE = Math.min(320, Math.max(64, parseInt(process.env.M4A_BITRATE || "192", 10) || 192));

const clampQuality = (q) => Math.min(320, Math.max(64, parseInt(String(q), 10) || M4A_BITRATE));

// "-threads 0" lets ffmpeg use every core (helps FLAC and the muxing/decode path);
// m4a gets "+faststart" so the moov atom is at the front and the file is usable /
// streamable the instant it lands on the device. For mp3/m4a we pin a constant
// bitrate (-b:a with matching min/max on mp3) so the output advertises exactly
// the requested kbps — a bitrate checker then shows the value the user chose.
const FORMATS = {
  mp3: { ext: "mp3", args: (q) => { const b = clampQuality(q); return ["-vn", "-map_metadata", "-1", "-threads", "0", "-c:a", "libmp3lame", "-b:a", `${b}k`, "-minrate", `${b}k`, "-maxrate", `${b}k`, "-bufsize", `${b}k`]; } },
  // M4A honours the selected quality (bounded 64–320). Defaults to M4A_BITRATE.
  m4a: { ext: "m4a", args: (q) => { const b = clampQuality(q); return ["-vn", "-map_metadata", "-1", "-threads", "0", "-c:a", "aac", "-b:a", `${b}k`, "-movflags", "+faststart"]; } },
  wav: { ext: "wav", args: () => ["-vn", "-map_metadata", "-1", "-threads", "0", "-c:a", "pcm_s16le"] },
  flac: { ext: "flac", args: () => ["-vn", "-map_metadata", "-1", "-threads", "0", "-c:a", "flac"] },
};

const router = express.Router();
// Give multer's uploaded temp files a known prefix so the periodic temp sweeper
// (server.js) can identify and reclaim orphans left by a crash/SIGKILL/aborted
// upload. Without a prefix multer uses a bare random name the age-based sweep
// can't safely target.
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, _file, cb) => cb(null, `scloudup_${crypto.randomBytes(12).toString("hex")}`),
});
const upload = multer({ storage: uploadStorage, limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });
let active = 0;
let activeSources = 0;
const usedDirectTickets = new Map();

const unlink = (p) => p && fs.promises.unlink(p).catch(() => {});

function validSig(payload, exp, sig) {
  if (!SECRET || !sig || !exp) return false;
  if (Date.now() / 1000 > Number(exp) + SIG_LEEWAY_S) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const secretOk = (req) => SECRET && (req.get("x-convert-secret") || "") === SECRET;

// Real audio MIME per output format — sent on the direct response so iOS saves a
// proper .mp3/.m4a/.wav/.flac instead of a generic ".bin".
const DIRECT_MIME = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac" };

// Signature for a browser-issued one-time direct ticket. The random ticket id and
// every plan cap are signed, so a ticket cannot be replayed or widened.
function validDirectSig(format, quality, maxmb, maxdur, ticket, exp, sig) {
  if (!SECRET || !sig || !exp) return false;
  if (Date.now() / 1000 > Number(exp) + SIG_LEEWAY_S) return false;
  if (!/^[a-zA-Z0-9_-]{20,80}$/.test(String(ticket || ""))) return false;
  const payload = `direct|${format}|${quality}|${maxmb}|${maxdur}|${ticket}|${exp}`;
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Signature for a cloud/URL source ticket. Only a SHA-256 digest of the source
// reference is included in the HMAC payload, so URLs cannot inject separators.
function validSourceSig(provider, sourceRef, format, quality, maxmb, maxdur, ticket, exp, sig) {
  if (!SECRET || !sig || !exp) return false;
  if (Date.now() / 1000 > Number(exp) + SIG_LEEWAY_S) return false;
  if (!/^[a-zA-Z0-9_-]{20,80}$/.test(String(ticket || ""))) return false;
  const sourceHash = crypto.createHash("sha256").update(String(sourceRef || "")).digest("hex");
  const payload = `source|${provider}|${sourceHash}|${format}|${quality}|${maxmb}|${maxdur}|${ticket}|${exp}`;
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function consumeDirectTicket(ticket, exp) {
  const now = Math.floor(Date.now() / 1000);
  for (const [key, expires] of usedDirectTickets) {
    if (expires < now) usedDirectTickets.delete(key);
  }
  if (usedDirectTickets.has(ticket)) return false;
  usedDirectTickets.set(ticket, Number(exp) || now + 180);
  return true;
}

// Signed proof that a CHARGED ticket did not produce a file, so WordPress can
// refund the daily-conversion count it reserved at ticket-issue time. Signed with
// the shared convert secret, so a browser cannot forge a "failure" to dodge the
// daily limit. Only ever emitted alongside consuming the ticket (single-use), so
// a refunded ticket can never be retried for a free conversion.
function refundToken(ticket, exp) {
  if (!SECRET) return "";
  return crypto.createHmac("sha256", SECRET).update(`refund|${ticket}|${exp}`).digest("hex");
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

class SourceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function blockedIp(address) {
  const value = String(address || "").toLowerCase().split("%")[0];
  const version = net.isIP(value);
  if (version === 4) {
    const p = value.split(".").map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 0 && (p[2] === 0 || p[2] === 2)) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51)) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113);
  }
  if (version === 6) {
    if (value.startsWith("::ffff:")) return blockedIp(value.slice(7));
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
      /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("2001:db8:");
  }
  return true;
}

async function assertPublicUrl(raw) {
  let parsed;
  try { parsed = new URL(String(raw || "")); }
  catch (e) { throw new SourceError("bad_source_url", 400); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new SourceError("bad_source_url", 400);
  }
  if (parsed.port && !["80", "443"].includes(parsed.port)) {
    throw new SourceError("unsafe_source", 400);
  }
  const literalHost = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literalHost)) {
    if (blockedIp(literalHost)) throw new SourceError("unsafe_source", 400);
    return { parsed, address: literalHost, family: net.isIP(literalHost) };
  }
  let addresses;
  try { addresses = await dns.lookup(parsed.hostname, { all: true }); }
  catch (e) { throw new SourceError("source_not_found", 404); }
  // Drop anything that isn't a syntactically valid IP before we pin it.
  addresses = (addresses || []).filter((row) => net.isIP(row.address) !== 0);
  if (!addresses.length || addresses.some((row) => blockedIp(row.address))) {
    throw new SourceError("unsafe_source", 400);
  }
  // Prefer IPv4: it is always a clean dotted quad the connector accepts, and this
  // VPS has no working IPv6 egress — pinning a resolved IPv6 threw
  // ERR_INVALID_IP_ADDRESS and killed every Drive/cloud download. Fall back to the
  // first (v6) address only when no IPv4 record exists.
  const chosen = addresses.find((row) => Number(row.family) === 4) || addresses[0];
  return { parsed, address: chosen.address, family: Number(chosen.family) === 6 ? 6 : 4 };
}

// Pin the HTTP connection to the exact DNS address validated above. This closes
// the DNS-rebinding gap that exists when validation and the actual request each
// perform their own lookup.
async function publicRequest(raw, headers, signal) {
  const approved = await assertPublicUrl(raw);
  const transport = approved.parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(approved.parsed, {
      method: "GET",
      headers,
      signal,
      family: approved.family,
      lookup(_hostname, _options, callback) {
        callback(null, approved.address, approved.family === 6 ? 6 : 4);
      },
    }, resolve);
    request.once("error", reject);
    request.end();
  });
}

function dropboxHostAllowed(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "dropbox.com" || host.endsWith(".dropbox.com") ||
    host === "dropboxusercontent.com" || host.endsWith(".dropboxusercontent.com");
}

function sourceRequest(provider, sourceRef, accessToken) {
  if (provider === "google") {
    if (!/^[a-zA-Z0-9_-]{5,220}$/.test(sourceRef) || !accessToken) throw new SourceError("bad_source", 400);
    return {
    // acknowledgeAbuse=true is REQUIRED for Drive to serve a file its scanner has
    // flagged (very common for music tracks that were themselves downloaded from
    // the web); without it the media endpoint answers 403 cannotDownloadAbusiveFile.
    // supportsAllDrives lets picked files that live on a shared drive download too.
      url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceRef)}?alt=media&acknowledgeAbuse=true&supportsAllDrives=true`,
      authorization: `Bearer ${accessToken}`,
    };
  }
  if (provider === "onedrive") {
    let item;
    try { item = JSON.parse(sourceRef); } catch (e) { throw new SourceError("bad_source", 400); }
    const driveId = String(item?.driveId || "");
    const itemId = String(item?.itemId || "");
    if (!/^[a-zA-Z0-9!._-]{1,240}$/.test(driveId) || !/^[a-zA-Z0-9!._-]{1,240}$/.test(itemId) || !accessToken) {
      throw new SourceError("bad_source", 400);
    }
    return {
      url: `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`,
      authorization: `Bearer ${accessToken}`,
    };
  }
  if (provider === "dropbox") {
    let parsed;
    try { parsed = new URL(sourceRef); } catch (e) { throw new SourceError("bad_source", 400); }
    if (parsed.protocol !== "https:" || !dropboxHostAllowed(parsed.hostname)) throw new SourceError("bad_source", 400);
    return { url: parsed.toString(), authorization: "" };
  }
  if (provider === "url") return { url: sourceRef, authorization: "" };
  throw new SourceError("bad_provider", 400);
}

// A Drive `alt=media` download very often 302-redirects from www.googleapis.com to
// one of Google's own file-serving hosts, and THAT host still needs the bearer to
// authorize the byte stream. Stripping the token on every redirect (the safe rule
// for arbitrary hosts) therefore breaks Google downloads. So for the google
// provider we keep forwarding the token to Google-owned hosts only — never to a
// third party. Other providers keep the strict first-host-only rule.
function authAllowedHost(provider, host, firstHost) {
  const h = String(host || "").toLowerCase();
  if (h === firstHost) return true;
  if (provider === "google") {
    return h === "drive.usercontent.google.com" ||
      h.endsWith(".googleusercontent.com") ||
      h.endsWith(".googleapis.com") ||
      h.endsWith(".l.google.com");
  }
  return false;
}

async function downloadSource(provider, sourceRef, accessToken, output, maxBytes) {
  const source = sourceRequest(provider, sourceRef, accessToken);
  const firstHost = new URL(source.url).hostname.toLowerCase();
  let current = source.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_S * 1000);
  let handle = null;
  let response = null;
  try {
    for (let hop = 0; hop <= SOURCE_REDIRECTS; hop++) {
      const parsed = new URL(current);
      const headers = { "User-Agent": "SCloud-Audio-Converter/1.2" };
      // Forward the bearer only to the origin host and (for Google) its own
      // download hosts — never to a third party a redirect might point at.
      if (source.authorization && authAllowedHost(provider, parsed.hostname, firstHost)) {
        headers.Authorization = source.authorization;
      }
      response = await publicRequest(parsed, headers, controller.signal);
      const status = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        console.error("[convert-source]", provider, "hop", hop, parsed.hostname, "->", status,
          location ? "redirect " + (() => { try { return new URL(location, parsed).hostname; } catch (e) { return "(bad location)"; } })() : "(NO location header)");
        if (hop >= SOURCE_REDIRECTS) throw new SourceError("too_many_redirects", 400);
        if (!location) throw new SourceError("source_download_failed", 502);
        response.resume();
        current = new URL(location, parsed).toString();
        continue;
      }
      console.error("[convert-source]", provider, "hop", hop, parsed.hostname, "->", status,
        "type", response.headers["content-type"] || "?", "len", response.headers["content-length"] || "?");
      break;
    }
    if (!response) throw new SourceError("source_download_failed", 502);
    const status = Number(response.statusCode || 0);
    if (status < 200 || status >= 300) {
      // Read a small slice of the provider's error body so the reason (e.g.
      // cannotDownloadAbusiveFile, insufficientFilePermissions) shows in the log.
      // Tokens are never included — this is only the provider's own response.
      let reason = "";
      try {
        let acc = "";
        for await (const chunk of response) { acc += chunk.toString(); if (acc.length > 2048) break; }
        const m = acc.match(/"reason"\s*:\s*"([^"]+)"/) || acc.match(/"message"\s*:\s*"([^"]+)"/);
        reason = m ? m[1] : acc.slice(0, 200).replace(/\s+/g, " ").trim();
      } catch (e) {}
      console.error("[convert-source]", provider, "HTTP", status, reason);
      if (status === 401 || status === 403) throw new SourceError("source_auth_failed", 401);
      if (status === 404) throw new SourceError("source_not_found", 404);
      throw new SourceError("source_download_failed", 502);
    }
    const declared = parseInt(response.headers["content-length"] || "0", 10) || 0;
    if (maxBytes > 0 && declared > maxBytes) throw new SourceError("file_too_large", 413);

    handle = await fs.promises.open(output, "wx", 0o600);
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (maxBytes > 0 && bytes > maxBytes) throw new SourceError("file_too_large", 413);
      await handle.write(chunk);
    }
    if (bytes < 1) throw new SourceError("source_empty", 400);
    return bytes;
  } catch (e) {
    if (response && !response.destroyed) response.destroy();
    if (e && e.name === "AbortError") throw new SourceError("source_timeout", 504);
    throw e;
  } finally {
    clearTimeout(timer);
    if (handle) await handle.close().catch(() => {});
  }
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
function convertAndSend(req, res, { input, format, quality, prefix, name, refundTicket = "", refundExp = "" }) {
  const spec = FORMATS[format];
  const output = path.join(os.tmpdir(), `${prefix}_${crypto.randomBytes(8).toString("hex")}.${spec.ext}`);
  const cleanup = () => { unlink(input); unlink(output); };
  const fail = (code, msg) => {
    cleanup();
    if (!res.headersSent && !res.writableEnded) {
      const body = { error: msg };
      // A charged ticket that failed to produce a file → hand WordPress a signed
      // refund proof so it reverses the reserved daily-conversion count.
      if (refundTicket) body.refund = refundToken(refundTicket, refundExp);
      res.status(code).json(body);
    }
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

    // Reject an over-large generated file (e.g. a huge WAV blown up from a small
    // lossy input) and delete it, rather than streaming half a gigabyte back.
    if (OUTPUT_MAX_MB > 0 && bytes > OUTPUT_MAX_MB * 1024 * 1024) {
      console.error(`[${prefix}] output ${bytes} bytes exceeds ${OUTPUT_MAX_MB} MB cap`);
      return fail(413, "output_too_large");
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
  const ticket = String(req.body.ticket || "");
  const exp = req.body.exp, sig = req.body.sig;

  if (!FORMATS[format]) return fail(400, "bad_format");
  if (!validDirectSig(format, quality, maxmb, maxdur, ticket, exp, sig)) return fail(403, "bad_signature");
  // Busy is transient and the browser retries the SAME ticket, so check it BEFORE
  // consuming — a 503 must not burn the ticket.
  if (active >= MAX_CONCURRENCY) return fail(503, "busy");

  // The ticket is valid and was already charged by WordPress. Make it single-use
  // NOW, so any failure below both refunds that charge and prevents a free retry
  // with the same ticket. A replay of an already-used ticket gets no refund.
  if (!consumeDirectTicket(ticket, exp)) return fail(409, "ticket_used");
  const failRefund = (code, msg) => {
    unlink(input);
    if (!res.headersSent && !res.writableEnded) res.status(code).json({ error: msg, refund: refundToken(ticket, exp) });
  };

  if (maxmb > 0 && req.file.size > maxmb * 1024 * 1024) return failRefund(413, "file_too_large");

  // Enforce the signed duration cap (plan limit) before spending CPU on convert.
  if (maxdur > 0) {
    const dur = await probeDuration(input);
    if (dur <= 0) return failRefund(400, "unreadable");
    if (dur > maxdur + 1) return failRefund(413, "too_long");
  }

  convertAndSend(req, res, { input, format, quality, prefix: "scloudd", name: req.body.name || "converted", refundTicket: ticket, refundExp: exp });
});

/* -------- POST /convert-source : URL / Drive / Dropbox / OneDrive -------- */
/* WordPress signs the provider, immutable source reference and every plan cap.
   OAuth access tokens travel directly from the browser to this VPS, are used for
   this one request only, and are never written to disk or logs. */
router.post("/convert-source", upload.none(), async (req, res) => {
  const provider = String(req.body.provider || "").toLowerCase();
  const sourceRef = String(req.body.source_ref || "");
  const accessToken = String(req.body.access_token || "");
  const format = String(req.body.format || "").toLowerCase();
  const quality = Math.min(320, Math.max(64, parseInt(req.body.quality || "192", 10) || 192));
  const maxmb = parseInt(req.body.maxmb || "0", 10) || 0;
  const maxdur = parseInt(req.body.maxdur || "0", 10) || 0;
  const ticket = String(req.body.ticket || "");
  const exp = req.body.exp;
  const sig = req.body.sig;
  const input = path.join(os.tmpdir(), `scloudsrc_${crypto.randomBytes(12).toString("hex")}`);
  let sourceSlot = false;
  let consumed = false;
  const fail = (code, msg) => {
    unlink(input);
    if (!res.headersSent && !res.writableEnded) {
      const body = { error: msg };
      // Refund the reserved count only once the ticket has been consumed (charged).
      if (consumed) body.refund = refundToken(ticket, exp);
      res.status(code).json(body);
    }
  };

  if (!FORMATS[format]) return fail(400, "bad_format");
  if (!validSourceSig(provider, sourceRef, format, quality, maxmb, maxdur, ticket, exp, sig)) {
    return fail(403, "bad_signature");
  }
  if (sourceRef.length < 1 || sourceRef.length > 5000 || accessToken.length > 12000) return fail(400, "bad_source");
  // Busy is transient and retried with the SAME ticket → check before consuming.
  if (active + activeSources >= MAX_CONCURRENCY) return fail(503, "busy");

  // Charged ticket → single-use now; every failure below refunds it (see fail()),
  // and the ticket can't be retried for a free conversion.
  if (!consumeDirectTicket(ticket, exp)) return fail(409, "ticket_used");
  consumed = true;

  activeSources++;
  sourceSlot = true;
  try {
    const maxBytes = maxmb > 0 ? maxmb * 1024 * 1024 : MAX_MB * 1024 * 1024;
    await downloadSource(provider, sourceRef, accessToken, input, Math.min(maxBytes, MAX_MB * 1024 * 1024));
    const dur = await probeDuration(input);
    if (dur <= 0) throw new SourceError("unreadable", 400);
    if (maxdur > 0 && dur > maxdur + 1) throw new SourceError("too_long", 413);

    activeSources = Math.max(0, activeSources - 1);
    sourceSlot = false;
    convertAndSend(req, res, { input, format, quality, prefix: `scloud-${provider}`, name: req.body.name || "converted", refundTicket: ticket, refundExp: exp });
  } catch (e) {
    if (sourceSlot) activeSources = Math.max(0, activeSources - 1);
    const status = e instanceof SourceError ? e.status : 502;
    const code = e instanceof SourceError ? e.code : "source_download_failed";
    if (!(e instanceof SourceError)) console.error("[convert-source]", provider, e.code || "", e.message || e);
    fail(status, code);
  }
});

router.get("/convert-health", (_req, res) => {
  const configured = Boolean(SECRET);
  res.status(configured ? 200 : 503).json({
    status: configured ? "ok" : "misconfigured",
    configured,
    active,
    importing: activeSources,
    concurrency: MAX_CONCURRENCY,
    m4aBitrateKbps: M4A_BITRATE,
    maxInputMb: MAX_MB,
    maxOutputMb: OUTPUT_MAX_MB,
  });
});

router.use((e, _req, res, _next) => {
  if (e && e.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "file_too_large" });
  res.status(500).json({ error: "server_error" });
});

router.getStatus = () => ({
  configured: Boolean(SECRET),
  active,
  importing: activeSources,
  concurrency: MAX_CONCURRENCY,
  m4aBitrateKbps: M4A_BITRATE,
  maxInputMb: MAX_MB,
  maxOutputMb: OUTPUT_MAX_MB,
});

module.exports = router;
