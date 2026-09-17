# TrackGrab 1.3.7 download compatibility update

The backend now tries every available source stream. Full streams remain preferred, and an available preview can download when SoundCloud exposes no full recording. An unavailable rendition can fall back to another usable source during format selection.

A preview is identified by `X-TrackGrab-Preview: 1` and a ` (preview)` filename suffix. The header is exposed through CORS. Single-track `/info` adds `preview_only` (`true`, `false`, or `null` when format metadata is unknown). Flat playlist entries are resolved when each track downloads. The standalone page displays preview status as well.

## Install on the VPS

1. Back up the current application and preserve production environment values, API secrets, converter settings, and executable paths.
2. Upload the full updated backend folder, including the helper files, lockfile, and `ecosystem.config.cjs`.
3. With the production environment loaded, run:

```bash
cd /path/to/trackgrab-backend
npm ci --omit=dev
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
curl -fsS https://api.downloadscloudmp3.com/diag
pm2 logs trackgrab --lines 80 --nostream
```

Diagnostics must show `version: "1.3.7"` and `ok: true` for `ytdlp`, `ffmpeg`, and `ffprobe`. Keep the VPS and WordPress shared secrets identical. Update yt-dlp using the installation's supported update method so it recognizes current SoundCloud sources. This archive has not been deployed to the live server.

## Behavior

- The local preview exclusion is removed. All formats supported by the extractor are requested, with availability checked before selecting audio.
- Actual source restrictions still apply: removing application checks cannot recover media that SoundCloud does not provide to the server because of DRM, regional availability, missing private access, deletion, or removal.
- The final error diagnostic is classified instead of earlier warnings or URLs. A track title containing "private" or "preview" no longer incorrectly suppresses a network retry.
- Queued jobs, disconnect handling, signed links, isolated temporary files, completed-file checks, and audio codec verification remain in place.
- Optional artwork/tag failures can retry without metadata. A playlist is expanded through `/info`, and each returned track URL gets its own download job.

Defaults remain `DOWNLOAD_ATTEMPTS=2`, `DOWNLOAD_RETRY_DELAY_MS=2000`, `DOWNLOAD_QUEUE_TIMEOUT_S=60`, `DOWNLOAD_TIMEOUT_S=900`, `SHUTDOWN_GRACE_S=930`, and PM2 `kill_timeout=960000` milliseconds. Source availability fallback happens within an attempt; transient failures use the bounded retry allowance.

## Validation

All 41 offline regression checks passed for this release. They cover preview metadata and labeled downloads, browser access to the preview header, format selection arguments, error classification, queueing, cancellation, signatures, retries, complete-file detection, five audio formats, and cleanup. Run `npm test` to repeat them.

These fixtures validate application behavior; they do not establish that every SoundCloud track is available from the production VPS. Run an available-track and mixed-playlist check there after deployment. Older live checks in `PLAYLIST-RESULTS.md` and previous changelog entries are historical records, not new validation of this release.

See `VPS-DEPLOYMENT.md` for deployment settings and a manual format-selection check.