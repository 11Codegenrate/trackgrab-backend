/**
 * Read-only production health check. It detects the exact self-redirect loop
 * that can make the WordPress site look down even while the VPS API is healthy.
 * Run with `npm run monitor`; a non-zero exit code is suitable for cron/alerts.
 */

const SITE_URL = process.env.MONITOR_SITE_URL || "https://downloadscloudmp3.com/audio-converter/";
const API_URL = (process.env.MONITOR_API_URL || "https://api.downloadscloudmp3.com").replace(/\/$/, "");
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.MONITOR_TIMEOUT_MS || "15000", 10) || 15000);

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkSite(startUrl) {
  let current = new URL(startUrl).toString();
  const seen = new Set();
  for (let hop = 0; hop <= 8; hop++) {
    if (seen.has(current)) throw new Error(`redirect loop detected at ${current}`);
    seen.add(current);
    const response = await request(current, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`HTTP ${response.status} without Location`);
      const next = new URL(location, current).toString();
      if (next === current) throw new Error(`self-redirect ${response.status}: ${current}`);
      current = next;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true, status: response.status, finalUrl: current, redirects: hop };
  }
  throw new Error("too many redirects");
}

async function checkJson(path) {
  const response = await request(`${API_URL}${path}`);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  const data = await response.json();
  return data;
}

async function main() {
  const result = { checkedAt: new Date().toISOString(), site: null, api: null, diag: null, converter: null };
  const failures = [];

  try { result.site = await checkSite(SITE_URL); }
  catch (e) { failures.push(`site: ${e.message}`); result.site = { ok: false, error: e.message }; }

  try { result.api = await checkJson("/"); }
  catch (e) { failures.push(`api: ${e.message}`); result.api = { ok: false, error: e.message }; }

  try {
    result.diag = await checkJson("/diag");
    if (!result.diag?.ytdlp?.ok) failures.push("diag: yt-dlp is not runnable");
    if (!result.diag?.ffmpeg?.ok) failures.push("diag: FFmpeg is not runnable");
  } catch (e) { failures.push(`diag: ${e.message}`); result.diag = { ok: false, error: e.message }; }

  try {
    result.converter = await checkJson("/convert-health");
    if (!result.converter?.configured) failures.push("converter: CONVERT_SECRET is not configured");
  } catch (e) { failures.push(`converter: ${e.message}`); result.converter = { ok: false, error: e.message }; }

  console.log(JSON.stringify({ ok: failures.length === 0, failures, ...result }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, fatal: e.message }));
  process.exitCode = 1;
});
