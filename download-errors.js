function classifyDownloadError(stderr, context = {}) {
  const text = String(stderr || "").toLowerCase();
  const info = (status, code, category, message, hint, retryable = false, retryAfterSeconds = 0) =>
    ({ status, code, category, message, hint, retryable, retryAfterSeconds });
  if (context.error?.code === "ENOENT") return info(503, "tool_missing", "tool-missing", "The download service is temporarily unavailable.", "Please try again after the service has been restored.");
  if (context.timedOut) return info(504, "download_timeout", "timeout", "This download took too long to finish.", "Please try again in a moment.", true, 3);
  if (context.signal || /interrupted by user/.test(text)) return info(503, "download_interrupted", "interrupted", "This download was interrupted before it finished.", "Please try again in a moment.", true, 3);
  if (/\bdrm\b|digital rights management/.test(text)) return info(422, "drm_protected", "drm", "SoundCloud protects this track and does not provide a downloadable audio file.", "You can continue with other available tracks.");
  if (/geo[ -]?(restriction|restricted|block)|not available from your location|not available in your country|region[- ]?(blocked|restricted)/.test(text)) return info(422, "geo_restricted", "geo", "This track is unavailable in the server's region.", "You can continue with other available tracks.");
  if (/http error 429|too many requests|rate.?limit/.test(text)) return info(429, "rate_limited", "ratelimit", "SoundCloud is temporarily limiting downloads.", "Please wait before trying again.", true, 30);
  if (/go\+|preview|snippet|snipped|purchase|subscription/.test(text)) return info(422, "preview_only", "unavailable", "SoundCloud only provides a preview of this track.", "A full download is unavailable. You can continue with other tracks.");
  if (/private|unauthoriz|sign in|log ?in|login required/.test(text)) return info(403, "track_private", "private", "This track requires access that the download service does not have.", "Use a public track or a valid private sharing link.");
  if (!/fragment|segment/.test(text) && /track.*not found|video.*not found|has been removed|does not exist|http error 404/.test(text)) return info(404, "track_unavailable", "unavailable", "This track is no longer available on SoundCloud.", "You can continue with other available tracks.");
  if (/ffmpeg|ffprobe|postprocessing|post-processing/.test(text)) return info(502, "conversion_failed", "ffmpeg", "The audio file could not be prepared.", "Please try again in a moment.");
  if (/timed? out|timeout|connection|network|temporar|http error 5\d\d|remote end closed|fragment .*not found|unable to download.*fragment/.test(text)) return info(502, "upstream_unavailable", "network", "SoundCloud could not finish sending this track.", "Please try again in a moment.", true, 2);
  if (/http error 403|forbidden/.test(text)) return info(502, "upstream_forbidden", "upstream", "SoundCloud rejected this audio request.", "Please try again in a moment.", true, 2);
  if (/requested format.*not available|no video formats|no audio/.test(text)) return info(422, "audio_unavailable", "unavailable", "SoundCloud does not provide a full downloadable stream for this track.", "You can continue with other available tracks.");
  if (/unable to extract|unsupported url|nonetype|failed to parse|unable to parse/.test(text)) return info(502, "extractor_failed", "extractor", "The download service could not read this track.", "Please try again after the service has been updated.");
  return info(502, "download_failed", "unknown", "This track could not be downloaded.", "Please try another track, or try again later.");
}

function sendDownloadError(res, info) {
  if (res.destroyed || res.writableEnded || res.headersSent) return;
  if (info.retryAfterSeconds) res.setHeader("Retry-After", String(info.retryAfterSeconds));
  res.setHeader("Cache-Control", "no-store");
  const { status, ...body } = info;
  // Preserve category/message/hint for the existing WordPress downloader.
  res.status(status).json({ error: info.message, ...body });
}

module.exports = { classifyDownloadError, sendDownloadError };
