# TrackGrab 1.3.6 download fix

The supplied server logs show two kinds of failures: SoundCloud explicitly refuses geo-restricted and DRM-protected tracks, and the old application mishandles queued/interrupted jobs. This update fixes the application problems and gives specific errors for unavailable tracks. It can download full, unprotected audio available from the VPS location; it cannot download every restricted, private, deleted, or preview-only track.

## Install on the VPS

1. Back up the current application and preserve its production environment, API secrets, converter secret, and executable paths using your existing deployment method.
2. Upload the **entire updated backend folder**, including helper files and `ecosystem.config.cjs`, to the existing application directory.
3. With the existing production environment loaded, run:

```bash
cd /path/to/trackgrab-backend
npm ci --omit=dev
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
curl -fsS https://api.downloadscloudmp3.com/diag
pm2 logs trackgrab --lines 80 --nostream
```

Diagnostics must show backend `version: "1.3.6"` and all three tool checks (`ytdlp`, `ffmpeg`, `ffprobe`) with `ok: true`. Keep the VPS and WordPress shared secrets identical. Never paste them into client HTML or enable public open API mode to work around authorization errors. This package has been prepared locally; it has not been deployed to your live server.

## What changes

- Queued requests are retained correctly, expire after 60 seconds by default, and are removed on disconnect.
- Tool stdout/stderr is drained, and timeouts/disconnects stop the Linux process group.
- Each attempt has its own temporary directory. Only exit-zero audio with an `after_move` completion marker and a successful timed FFprobe check is served.
- Transient failures may receive one retry by default; DRM, geo, private, and preview-only errors are not retried. Optional metadata failures can retry without artwork/tags.
- `/diag` reports backend version and FFprobe health. API errors preserve `category`, `message`, and `hint`, and add `code`, `retryable`, and retry timing.

Defaults: `DOWNLOAD_ATTEMPTS=2`, `DOWNLOAD_RETRY_DELAY_MS=2000`, `DOWNLOAD_QUEUE_TIMEOUT_S=60`, `DOWNLOAD_TIMEOUT_S=900`, `SHUTDOWN_GRACE_S=930`, and PM2 `kill_timeout=960000` milliseconds. PM2 must allow more time than the application's shutdown grace; avoid repeated restarts during active downloads.

## Verify downloads

On the same VPS, choose a public track you are authorized to download and check its formats:

```bash
yt-dlp --ignore-config --no-playlist --skip-download -F 'https://soundcloud.com/ARTIST/PUBLIC-TRACK'
```

Replace the example URL and use the executable configured in `/diag`. Test an available track in the production downloader, then a mixed playlist. Explicit DRM/geo errors mean the provider does not make that audio available to this server. A working version probe alone does not prove a particular track is downloadable.

The WordPress downloader plugin responsible for the screenshot is **not present in the supplied ZIP**, so its exact modal and batch behavior cannot be changed here. It can display the backend's preserved `message`/`hint` and use the new error fields. The included standalone `index.html` adds sequential playlist MP3 downloads and per-track results, but retains its original open-API-only connection model. Browsers may require permission for multiple file downloads; the page reports files sent to the browser rather than claiming they were all saved.

See `VPS-DEPLOYMENT.md` for complete settings, proxy checks, and manual MP3 verification.

## Local validation

All 35 regression checks passed. These cover real process lifecycle handling and offline HTTP fixtures for queueing, cancellation, signatures, retries, unavailable tracks, complete-file detection, all five output formats, and cleanup.

A real public SoundCloud sample (143.206 seconds) was also downloaded through the repaired local API as MP3, M4A, MP4 audio, WAV, and FLAC. Each file's actual codec/container and full duration were verified using FFprobe. This validation used Windows, yt-dlp 2026.08.19, and FFmpeg/FFprobe 9.0; repeat an available-track check on your Ubuntu VPS after deployment.

Run the included regression checks with `npm test`. Compatible lockfile dependency updates were applied; the dependency audit reported no known vulnerabilities at validation time.

## Exact playlist supplied by the user

The supplied URL is a 21-track playlist: `https://soundcloud.com/playlist/sets/underground-italia-hip-hop`. Testing from the local test connection found 1 DRM-protected track, 9 geo-restricted tracks, and 11 tracks offering only 30-second previews. All 11 preview results were confirmed by listing every exposed format. No full unprotected track was available from this test location. The VPS region can affect the geo results; repeat the check there if needed.

Version 1.3.6 adds a guard preventing a whole playlist URL from entering a single-file `/download` job. `--no-playlist` alone does not stop SoundCloud set expansion. First expand the URL through `/info`, then download each returned track URL separately; the supplied standalone playlist page already does this. Three new checks cover 21-entry playlist results, playlist rejection, and individual links carrying playlist context.
