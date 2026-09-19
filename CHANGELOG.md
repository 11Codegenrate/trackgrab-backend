# Changelog

## 1.6.0

- **Maximum download speed.** Added the aria2c external downloader, used automatically for every download (normal, direct-progressive recovery, and preview fallback) when the `aria2c` binary is available. SoundCloud's progressive rendition is a single HTTP file, so yt-dlp's native one-connection download is latency-bound; aria2c opens up to 16 parallel connections/segments to the same CDN file and pulls it several times faster — the main lever for fast single-track downloads. It also parallelizes HLS fragments. **Proxy safety:** aria2c has no SOCKS support, so when `SOUNDCLOUD_PROXY` is a `socks*` proxy we keep yt-dlp's native downloader (which does route through SOCKS), so region-locked/proxied tracks never break. Tune with `YTDLP_DOWNLOADER=auto|native|aria2c`, `ARIA2C_CONNECTIONS` (default 16), `ARIA2C_PATH`.
- Raised default concurrency: `MAX_CONCURRENT` 2→3 and native `YTDLP_FRAGMENTS` 4→8 (clamped to 16). Both still env-tunable.
- `/diag` now reports a `speed` block (`downloader`, `aria2c` availability, `mode`, `connections`, `fragments`) so you can confirm acceleration is live. Boot log prints whether aria2c is on.
- No change to download accuracy: the ffprobe container/codec verification and true-CBR MP3 enforcement are untouched, so files stay exactly the requested format/bitrate. **Deploy note:** install aria2c on the VPS (`apt-get install -y aria2`) to enable the speed-up; without it the backend automatically uses the native downloader.

## 1.5.3

- Send `Authorization: OAuth <SOUNDCLOUD_OAUTH_TOKEN>` on the api-v2 media/resolve requests when a token is configured. Diagnostics showed the progressive/plain-hls media endpoints return 401 to anonymous (client_id/track_authorization-only) requests for some tracks — SoundCloud's web player authenticates with an OAuth token, which is what unlocks these renditions. With a token set (any account; also used by yt-dlp via cookies), the progressive recovery path can resolve a real media URL.

## 1.5.2

- Media-URL resolution fixed and broadened. Diagnostics showed the progressive rendition exists (with `track_authorization`) but resolving it with `client_id`+`track_authorization` returned 404. SoundCloud's newer streams are unlocked by `track_authorization` sent WITHOUT a `client_id` (as the web player does), so we now try that form first, then `client_id`+`track_authorization`, then `client_id` alone. We also now fall back from progressive to plain (non-encrypted) `hls` before giving up; only `*-encrypted-hls` renditions are treated as unavailable.

## 1.5.1

- Route ALL SoundCloud api-v2 / client_id traffic through `curl` (which honours the region proxy) instead of Node's global `fetch` (no SOCKS support). A direct Singapore request was being refused/limited, which silently broke both the personalized "related tracks" resolve (1.4.1) and the progressive/`track_authorization` recovery (1.5.0). Now everything resolves from the allowed region, like the web player.
- Added `[direct]`/`[resolve]` diagnostics (transcodings list, track_authorization presence, failure reason) so download-path failures are traceable in `pm2 logs`.

## 1.5.0

- Full-audio recovery for tracks yt-dlp reports as "DRM protected"/geo/unavailable. yt-dlp resolves SoundCloud streams with a `client_id` only and is then offered nothing but encrypted-HLS on some tracks, so it declares DRM — even though SoundCloud still serves a normal **progressive** file when asked with the track's `track_authorization` (exactly what the web player and web downloaders use). On such a failure, the backend now reads the track's `media.transcodings` + `track_authorization` (via `curl` through the region proxy so it resolves from the allowed region), picks the progressive rendition, and hands that direct CDN URL to yt-dlp to download and convert — a full track, not a preview. Does not decrypt DRM; uses the same public progressive file the site serves.
- Order of fallbacks on `/download`: normal yt-dlp → direct progressive (full) → preview snippet → error.

## 1.4.1

- Personalized/"related tracks" discover sets now resolve. For URLs like `/discover/sets/personalized-tracks::<user>:<seedTrackId>` (which 404 on `/resolve`), the backend reads the trailing seed track id and builds the set from that track's public `tracks/{id}/related` recommendations (plus the seed) — the same anonymous, client_id path SoundCloud's web player and web downloaders use. Tracks then download through the normal yt-dlp path.

## 1.4.0

- Added a SoundCloud api-v2 `/resolve` fallback on `/info`, used only when yt-dlp cannot read a URL. This handles "system"/personalized/discover set URLs (e.g. `/discover/sets/personalized-tracks::user:token`) that the yt-dlp set extractor 404s on — the same anonymous, public-`client_id` path SoundCloud's own web player (and web-based downloaders) use. No login required. The backend scrapes a `client_id`, calls `/resolve`, and batch-hydrates id-only system-playlist entries via `/tracks`. Resolved tracks then download through the normal yt-dlp path (proxy/geo/preview all still apply).
- Normal public tracks and playlists are unaffected — they still resolve through yt-dlp; the fallback only runs on failure.
- If a `client_id` request is rejected (401/403) it is re-scraped once.

## 1.3.9

- Optional SoundCloud authentication so the backend can fetch content the account is entitled to: private/unlisted tracks and personalized "discover" sets (e.g. `/discover/sets/personalized-tracks::user:token`) that SoundCloud returns 404 for when unauthenticated. Set `SOUNDCLOUD_COOKIES=/path/to/cookies.txt` (full Netscape cookies exported from a logged-in browser) or just `SOUNDCLOUD_OAUTH_TOKEN=<oauth_token cookie value>` (a minimal cookies file is materialized). Passed to yt-dlp via `--cookies` on `/info` and `/download`.
- `/diag` `region` block adds `auth` (`cookies`/`oauth`/`none`).
- Note: personalized/system "discover" sets are only fetchable with a valid session for the owning account; a normal public track/playlist never needs this.

## 1.3.8

- Region recovery: added optional outbound proxy for all SoundCloud requests (`SOUNDCLOUD_PROXY`, else `HTTPS_PROXY`/`HTTP_PROXY`). Point it at an egress in a region where the catalogue is available to recover tracks that report "unavailable in the server's region". Applies to `/info` and `/download`.
- Enabled yt-dlp's built-in geo circumvention by default (`--geo-bypass`); set `SOUNDCLOUD_GEO_BYPASS_COUNTRY=US` to force a country or `=off` to disable. Harmless for unrestricted tracks.
- Added a last-resort preview fallback on `/download`: when no full/available stream can be fetched (geo, Go+/DRM, preview-only, forbidden), the server retries once forcing any playable source — including the public ~30s preview snippet — with format pre-check off and unavailable fragments skipped, so a listed track still yields a labeled `(preview)` download instead of a hard failure. This does not circumvent DRM or fabricate audio SoundCloud withholds.
- `/diag` now reports a `region` block (proxy/geoBypass/previewFallback) so the active configuration is verifiable.
- Note: a track that is geo-blocked from the server AND has no configured allowed-region proxy, or a Go+/DRM track that exposes no public snippet, still cannot be downloaded — SoundCloud provides no fetchable audio in those cases.

## 1.3.7

- Removed the application filter that discarded available preview streams. Full streams remain preferred by yt-dlp, with a clearly labeled preview download when that is the available source.
- Added source availability checks during format selection so an unavailable rendition can fall back to another usable rendition within the same attempt.
- Preview responses include `X-TrackGrab-Preview: 1` (exposed through CORS) and a `(preview)` filename suffix. Single-track `/info` adds `preview_only`, with `null` when format metadata is unknown.
- Error classification uses the final failure diagnostic and ignores URLs, preventing track names or earlier warnings containing "preview", "private", or "DRM" from suppressing network retries.
- Preserved signatures, server security, resource limits, completed-file checks, and codec verification. Unavailable DRM, regional, private, or deleted audio cannot be recovered by removing local checks.
- Validation: 41 offline regression checks passed. No live deployment or current live SoundCloud download is claimed by this release.

## 1.3.6 (historical)

- Reject whole SoundCloud playlist URLs at the single-file `/download` endpoint after URL and signature validation. SoundCloud set expansion continues despite `--no-playlist`, so entries could otherwise collide in one output file. The `/info` playlist results must be downloaded per track. Individual tracks with a playlist-context query remain supported.
- Added tests using the supplied playlist's 21-entry shape, including its 16 API-only track URLs. All 35 regression checks pass.
- Checked the supplied Underground Italia: Hip-Hop playlist from the test connection: 1 DRM-protected track, 9 geo-restricted tracks, and 11 confirmed 30-second preview-only tracks. No full unprotected track was available from that location. These results do not imply the VPS has the same regional availability.

## 1.3.5

- Fixed downloader queue and process handling: waiting requests survive a normally completed GET request, disconnected/expired queue entries are removed, child output is drained continuously, and interruption/timeout cancels the Linux process group. PM2's shutdown allowance now exceeds the application's download drain period.
- Downloads run in isolated attempt directories and require exit code zero, an `after_move` completion marker inside the attempt directory, and a timed FFprobe container/codec check. Interrupted, partial, and unverified leftover files are rejected instead of being served merely because a file exists.
- Added bounded transient retries (two total attempts by default). Explicit DRM, geo, private-track, and preview-only failures are not retried. Optional artwork/tag failures can trigger a fresh attempt without metadata within the attempt and timeout limits.
- Added strict HTTP(S) SoundCloud hostname and query-type validation for `/info` and `/download`. Failures preserve `category`, `message`, and `hint` and also return `code`, `retryable`, and retry timing where appropriate.
- Added backend version and FFprobe health to `/diag`, alongside yt-dlp and FFmpeg checks. Defaults include `DOWNLOAD_ATTEMPTS=2`, `DOWNLOAD_RETRY_DELAY_MS=2000`, `DOWNLOAD_QUEUE_TIMEOUT_S=60`, `SHUTDOWN_GRACE_S=930`, and PM2 `kill_timeout=960000` milliseconds.
- Standalone `index.html` now renders playlists, downloads MP3 tracks sequentially, continues after per-track failures, supports stopping, rejects non-audio responses, and reports files sent to the browser separately from failures/unavailable tracks. Its original open-API-only connection model is unchanged. The production WordPress downloader plugin shown in the screenshot is not included in this ZIP.
- The supplied VPS logs contain explicit SoundCloud DRM/geo restrictions as well as interrupted jobs. This release fixes application bugs; it can only download full unprotected audio available to the VPS and does not make restricted tracks downloadable. No live deployment is claimed by this archive.

## 1.3.4

- Google Drive / cloud imports (`/convert-source`): fixed the real cause of "The source could not be downloaded" — the SSRF-safe downloader resolved the source host itself and pinned the address with `dns.lookup(..., { verbatim: true })`, which returned an IPv6 record first. This VPS has no working IPv6 egress, so pinning it threw `ERR_INVALID_IP_ADDRESS` and the request never reached Google. The resolver now prefers a valid IPv4 address (filtering malformed records and coercing the family), falling back to IPv6 only when no A record exists. SSRF protection (private-range blocking, IP pinning) is unchanged.

## 1.3.3

- Google Drive source imports (`/convert-source`): fixed downloads that failed with "The source could not be downloaded." `alt=media` frequently 302-redirects from `www.googleapis.com` to one of Google's own file-serving hosts (`drive.usercontent.google.com`, `*.googleusercontent.com`), and that host still needs the OAuth bearer to authorize the byte stream. We were stripping the token on every redirect, so the follow-up request failed. The bearer is now forwarded to Google-owned hosts only (never to a third party); other providers keep the strict first-host-only rule.
- `/convert-source` now logs each hop (host → status, redirect target or content-type/length) so cloud-import issues are fully diagnosable from the VPS log. Tokens are never logged.

## 1.3.2

- Google Drive source imports (`/convert-source`): the Drive `alt=media` download now sends `acknowledgeAbuse=true` (and `supportsAllDrives=true`). Without it Google refuses to serve any file its own scanner has flagged — extremely common for music tracks that were themselves downloaded from the web — which surfaced in the converter as "The source could not be downloaded. Please choose it again." Picked audio now downloads and converts.
- `/convert-source` now logs the provider's real HTTP status and error reason (e.g. `cannotDownloadAbusiveFile`, `insufficientFilePermissions`) on a failed source fetch, so cloud-import problems are diagnosable from the VPS log. OAuth tokens are never logged.

## 1.3.1

- Automatic VPS temp-file cleanup: a periodic sweeper removes orphaned `trackgrab-*` / `scloud*` temp files and directories in the system temp dir once they are older than `TEMP_MAX_AGE_MIN` (default 60), guarding against disk fill from crashes, SIGKILLs, per-job timeouts or aborted uploads. Runs every `TEMP_SWEEP_INTERVAL_MIN` (default 15), uses mtime only (never reaps a file still being written), and leaves the yt-dlp cache alone. Each job still cleans up after itself as before.
- Multer uploads now use a `scloudup_` temp-file prefix so the sweeper can reclaim orphaned uploads.

## 1.3.0

- Converter (`/convert-direct`, `/convert-source`): a **failed** conversion no longer costs the user a daily conversion. When a charged ticket can't produce a file, the response now includes a `refund` proof (HMAC of `refund|ticket|exp` with the convert secret) and the ticket is made single-use, so WordPress reverses the reserved count. A successful conversion returns no proof, and the signature stops a client faking a failure. A transient `busy` (503) is still retried with the same ticket and never consumes/refunds it.
- Downloads (`/download`): lossy formats (MP3, M4A/MP4) request the target conversion bitrate (default 320 kbps; MP3 uses CBR via matching `-b:a/-minrate/-maxrate`). Source quality depends on the stream SoundCloud provides. Re-encoding at 320 kbps or converting a lossy source to WAV/FLAC does not restore lost quality. WAV/FLAC output formats are unchanged.
- Converter (`/convert`, `/convert-direct`, `/convert-source`): M4A output now honours the selected quality (up to 320 kbps) instead of a fixed 128; MP3 is encoded true-CBR so the file reports the exact chosen bitrate.
- Converter: added a hard cap on the GENERATED output file (`CONVERT_OUTPUT_MAX_MB`, default 500). An over-large result (e.g. a huge WAV blown up from a small lossy input) is rejected with `output_too_large` and deleted instead of streamed. Input cap (`CONVERT_MAX_MB`) is unchanged and independent.
- `/convert-health`, `/diag` and `/` now report `maxInputMb` and `maxOutputMb`.

## 1.2.0

- Added signed `/convert-source` imports for direct audio URLs, Google Drive, Dropbox and OneDrive.
- Added streaming input-size enforcement, duration probing, redirect limits and SSRF protection for every remote hop.
- OAuth tokens are accepted only for the current conversion and are never persisted or logged.
- Added optional `CONVERT_ALLOWED_ORIGINS` CORS restriction and source-import health status.

## 1.1.3

- Converter (`/convert`, `/convert-direct`, `/probe`): `CONVERT_SECRET` now falls back to the same shared default the WordPress converter uses, so an unset/lost secret can't make every conversion fail with "session expired"; and the ticket/probe/convert signature checks now allow a clock-skew grace window (`CONVERT_SIG_LEEWAY_S`, default 600s). `CONVERT_OPEN=1` restores the old open behavior.

## 1.1.2

- Download-link check now allows a clock-skew grace window (SIG_LEEWAY_S, default 600s) between the WordPress box that stamps `exp` and this box that checks it, so a slightly fast/slow VPS clock no longer makes fresh links look "expired".
- API_SECRET now falls back to the same shared default the WordPress plugin ships with (instead of empty/open), so a redeploy or PM2 restart that loses the env var can no longer cause a secret mismatch that rejects every download. Set your own secret on both sides for real security; `SCLOUD_API_OPEN=1` restores the old open behavior.
- Rejected `/download` links now log the real reason (badsig / expired / missing) and return a `code: "bad_link"` so the browser can silently retry with a fresh link. The user-facing message is unchanged.

## 1.1.1

- Download signatures now cover every plan-controlled field, including priority queue access.
- Legacy signed links remain usable during a rolling deployment, but cannot enable priority mode.
- Direct converter tickets are random, short-lived, signed, and accepted only once.
- Busy direct-conversion requests do not consume the one-time ticket, so normal retry behavior remains reliable.
