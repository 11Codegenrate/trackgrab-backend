# SCloud VPS deployment and recovery

## Version 1.3.7: what this build fixes

The supplied logs show explicit SoundCloud geo-restriction and DRM errors. They also show interrupted processes, including a nonzero exit whose leftover file was previously served. An online PM2 process and successful yt-dlp/FFmpeg version checks do not prove a particular track is downloadable.

This release downloads available streams, including a preview if that is the only source SoundCloud exposes. Full streams remain preferred. Preview files are labeled in the filename and response header; a preview is not the full recording. Format availability checks allow a broken rendition to fall back to another usable source. DRM-protected, region-blocked, inaccessible private, and deleted audio remain subject to the source provider's availability. The prepared archive is not evidence of a live deployment.

- Downloader jobs are limited to two active jobs plus a bounded queue. Converter jobs default to one at a time, preventing five simultaneous FFmpeg processes from overwhelming a small VPS.
- Waiting downloads now have a queue timeout, are retained after a normally completed GET request, and are removed when their client disconnects.
- Downloader tool processes drain both stdout and stderr, keep bounded captured logs, and cancel their Linux process group on interruption or timeout. PM2's shutdown allowance exceeds the application's download drain period.
- Each download attempt uses an isolated temporary directory and requires exit code zero, an `after_move` completion marker inside that directory, and a timed FFprobe check of the requested container and audio codec. Interrupted or partial files are rejected.
- Transient errors may be retried within the job timeout. Explicit source access failures are reported accurately; available previews are attempted automatically. Optional artwork/tag failures can trigger a fresh attempt without metadata rather than serving an unverified leftover file.
- `X-TrackGrab-Preview: 1` identifies a completed preview download and is exposed through CORS. Single-track `/info` reports `preview_only` as true, false, or null when source metadata is unknown.
- `/info` and `/download` validate HTTP(S) SoundCloud hostnames and query value types. Error responses preserve `error`, `category`, `message`, and `hint`, and add `code`, `retryable`, and retry timing where applicable.
- `/diag` reports backend `version` plus yt-dlp, FFmpeg, and FFprobe health. Converter behavior is unchanged by this downloader fix.
- The supplied standalone `index.html` adds sequential playlist MP3 downloads, cancellation, per-track failure handling, and a summary of files sent to the browser. Its unsigned/open API connection model is unchanged.

## Historical redirect troubleshooting note: 27 August 2026

This earlier deployment note is retained for troubleshooting and was not reverified for version 1.3.7. It is separate from the current source-selection changes.

The earlier note reported `https://downloadscloudmp3.com/` and `/audio-converter/` returning `308 Permanent Redirect` with a `Location` header pointing to the exact same URL. Browsers stopped with `ERR_TOO_MANY_REDIRECTS`, while `https://api.downloadscloudmp3.com/diag` reported both yt-dlp and FFmpeg working at that time.

This failure is in the Cloudflare/WordPress-origin redirect layer, not in the Node API ZIP. In Cloudflare and the WordPress origin:

1. Open **Rules → Redirect Rules**, **Bulk Redirects**, and legacy **Page Rules**. Disable any rule that matches an already-HTTPS `downloadscloudmp3.com/*` request and redirects it to the same HTTPS URL.
2. Open **SSL/TLS → Overview** and use **Full (strict)** if the WordPress origin has a valid certificate. Do not use Flexible when the origin redirects HTTP to HTTPS.
3. Keep only one HTTP-to-HTTPS redirect layer. A valid rule must match `http://...`, not an already-HTTPS request.
4. Verify the WordPress **Site Address**, **WordPress Address**, web-server redirects, and any SSL/redirect plugin do not redirect an HTTPS request to the identical URL. When a reverse proxy terminates TLS, make sure WordPress recognizes the forwarded HTTPS scheme.
5. Purge Cloudflare cache, then run `npm run monitor`. The site check must show HTTP 200 instead of `self-redirect 308`.

## Deploy backend on the VPS

Back up the current application and preserve its production environment and secrets using the existing deployment method. Keep the WordPress and VPS shared secrets identical. Do not replace real secrets with example values, commit them, put them in browser HTML, or enable public open API mode to work around a configuration mismatch.

Upload the **full updated backend folder**, including the helper files, lockfile, and `ecosystem.config.cjs`. Replacing only `server.js` is insufficient. Run these commands with the existing production environment loaded:

```bash
cd /path/to/trackgrab-backend
npm ci --omit=dev
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
curl -fsS https://api.downloadscloudmp3.com/diag
curl -fsS https://api.downloadscloudmp3.com/convert-health
```

Diagnostics must report `"version":"1.3.7"` and `ytdlp.ok`, `ffmpeg.ok`, and `ffprobe.ok` all `true`. `--update-env` applies the deployment environment; it does not update source files or install dependencies. Check `pm2 logs trackgrab --lines 80 --nostream` after the reload.

| Setting | Default | Purpose |
| --- | --- | --- |
| `MAX_CONCURRENT` | `2` | Active downloader jobs |
| `MAX_QUEUE` | `30` | Waiting downloader jobs |
| `DOWNLOAD_TIMEOUT_S` | `900` | Total download processing deadline |
| `DOWNLOAD_ATTEMPTS` | `2` | Maximum attempts, including the initial attempt |
| `DOWNLOAD_RETRY_DELAY_MS` | `2000` | Delay before retrying |
| `DOWNLOAD_QUEUE_TIMEOUT_S` | `60` | Maximum wait for a downloader slot |
| `SHUTDOWN_GRACE_S` | `930` | Default download timeout plus 30 seconds |
| PM2 `kill_timeout` | `960000` ms | Allows application shutdown grace to finish |
| `SOUNDCLOUD_PROXY` | _(none)_ | Route all SoundCloud requests through this proxy URL. Set it to an egress in a region where the catalogue is available to recover "unavailable in the server's region" tracks. Falls back to `HTTPS_PROXY`/`HTTP_PROXY` if unset. |
| `SOUNDCLOUD_GEO_BYPASS_COUNTRY` | _(auto)_ | Force yt-dlp geo-bypass to a country code (e.g. `US`, `GB`, `DE`). Leave unset for automatic `--geo-bypass`; set `off` to disable it entirely. |
| `SOUNDCLOUD_COOKIES` | _(none)_ | Path to a Netscape `cookies.txt` exported from a browser logged into SoundCloud. Enables fetching private/unlisted tracks and personalized "discover" sets the account is entitled to. |
| `SOUNDCLOUD_OAUTH_TOKEN` | _(none)_ | Alternative to a cookies file: the `oauth_token` cookie value from a logged-in SoundCloud session. A minimal cookies file is generated from it. Ignored if `SOUNDCLOUD_COOKIES` is set. |

### SoundCloud login for private / personalized sets (1.3.9)

Public tracks and playlists never need this. But personalized "discover" sets (e.g. `/discover/sets/personalized-tracks::user:token`) and private/unlisted tracks return **404** to anonymous requests — they need a logged-in SoundCloud session. Provide one of:

- **Cookies file (recommended):** in a browser logged into SoundCloud, export `cookies.txt` (a "Get cookies.txt" extension), upload it to the VPS (e.g. `/opt/trackgrab/sc-cookies.txt`, `chmod 600`), then set `SOUNDCLOUD_COOKIES=/opt/trackgrab/sc-cookies.txt`.
- **OAuth token:** copy the `oauth_token` cookie value (DevTools → Application → Cookies → soundcloud.com → `oauth_token`) and set `SOUNDCLOUD_OAUTH_TOKEN=<value>`.

Confirm at `/diag` → `region.auth` shows `cookies` or `oauth`. Cookies expire; re-export if authenticated fetches start failing.

### Region recovery (1.3.8) — download every listed track

The single biggest cause of "0 full downloads" in a test is the **server's own region**: SoundCloud geo-blocks many tracks (and even their previews) for the IP the backend runs on. To get the coverage a competitor in another region has:

1. Deploy on (or route through) an egress where the catalogue is available. Set `SOUNDCLOUD_PROXY=http://user:pass@host:port` (an HTTP/HTTPS or SOCKS proxy yt-dlp accepts). This is the actual "bypass" — it makes region-locked streams and previews reachable.
2. `--geo-bypass` is on by default and needs no proxy; it clears some (not all) geo blocks on its own.
3. Even with neither, the backend now falls back to the public ~30s **preview** snippet for any track whose full stream is unavailable (geo/Go+/DRM/forbidden), so a listed track downloads a labeled `(preview)` file instead of failing. It cannot recover full audio SoundCloud withholds (true DRM) or a track that is geo-blocked from the server with no allowed-region proxy.

Confirm the active setup at `/diag` → `region` (e.g. `{ "proxy": "configured", "geoBypass": "auto", "previewFallback": true }`).

If the shutdown grace is increased, increase PM2's `kill_timeout` to exceed it. A reload may wait for an active download to finish. Avoid repeated restarts while testing downloads.

If yt-dlp was installed with its standalone binary, update it before restarting:

```bash
yt-dlp -U
pm2 restart trackgrab --update-env
```

For a package-managed installation, use its supported package manager. Confirm `/diag` probes the same executable path used by the service.

## Verify an available track from the same VPS

Choose a public SoundCloud track you are authorized to download and test from the same VPS where the application runs. Use the executable reported by `/diag` if `YTDLP_PATH` is configured. First check available formats, then produce an MP3:

```bash
yt-dlp --ignore-config --no-playlist --skip-download -F 'https://soundcloud.com/ARTIST/PUBLIC-TRACK'
yt-dlp --ignore-config --no-playlist --extractor-args 'soundcloud:formats=*' --format 'bestaudio[format_id!*=preview]/best[format_id!*=preview]/bestaudio/best' --check-formats -x --audio-format mp3 --audio-quality 320K --print 'after_move:COMPLETE:%(filepath)s' --print 'after_move:SOURCE:%(format_id)s' -o '/tmp/trackgrab-check.%(ext)s' -- 'https://soundcloud.com/ARTIST/PUBLIC-TRACK'
```

Replace the example URL with the chosen track. If the service configures an FFmpeg directory, include its matching `--ffmpeg-location` in this manual test. Then test single-track downloads in WordPress and a playlist containing both an available and a known unavailable track. Available files should complete; unavailable tracks should return their reason without preventing other available tracks being attempted.

An explicit DRM or geo-restriction result is an availability limit, not evidence that the local converter is missing. This release does not bypass those restrictions.

For nginx, keep request buffering enabled, allow the intended upload size, and give conversions time to finish:

```nginx
client_max_body_size 500m;
proxy_connect_timeout 30s;
proxy_send_timeout 900s;
proxy_read_timeout 900s;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

After editing nginx, validate before reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## WordPress deployment scope

The downloader WordPress plugin responsible for the screenshot is absent from this ZIP. This release updates the API and supplied standalone HTML only. The production plugin can display the preserved `category`, `message`, and `hint` fields and use `code`, `retryable`, and `retryAfterSeconds`, but its exact modal and playlist behavior cannot be changed without its source. Do not install `index.html` as a WordPress plugin or expose shared secrets in client code. Its standalone open API connection model is unchanged.

The following converter-plugin steps describe an earlier release. Its ZIP is not included in this backend archive, and its frontend is not part of this downloader fix.

Upload `scloud-audio-converter-1.7.0.zip`, replace/upgrade the existing plugin, and confirm these settings match the VPS:

- Convert service URL: `https://api.downloadscloudmp3.com`
- Convert secret: the exact `CONVERT_SECRET` value

Backend 1.2.0 adds `/convert-source` for direct URLs, Google Drive, Dropbox and OneDrive. `CONVERT_ALLOWED_ORIGINS` accepts a comma-separated list of exact WordPress origins. The backend validates every redirect and rejects local/private network destinations before it streams a remote file.

The earlier converter frontend release removed its Pro promotion card and Back to home link; those frontend changes are not supplied in this archive.

## Monitor after deployment

Run:

```bash
npm run monitor
```

It exits non-zero if the website loops/returns an error, the API is down, yt-dlp, FFmpeg, or FFprobe fails, or the converter secret is missing. Run this from an external uptime host where possible, because a check running only on the VPS cannot alert when the entire VPS is unreachable.

## Expected file-size behavior

- Converter M4A size depends on selected quality and deployed configuration. At 128 kbps, a roughly 3 minute 20 second track is usually near 3.1–3.4 MB plus container overhead; higher bitrates produce larger files. SoundCloud downloads use the requested conversion target when re-encoding, but yt-dlp may retain an already-matching source codec and its original bitrate. Re-encoding a lossy source at a higher bitrate does not restore lost quality.
- WAV is uncompressed PCM, so roughly 34 MB for that duration is normal.
- Converting MP3 to FLAC does not restore lost quality and often creates a very large FLAC (around the reported 32 MB) because MP3 artifacts compress poorly. A clean WAV of the same music may compress to a much smaller FLAC (the reported 16 MB is plausible). This is expected codec behavior, not a wrong-format result.
