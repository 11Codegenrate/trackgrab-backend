# Changelog

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
- Downloads (`/download`): lossy formats (MP3, M4A/MP4) are now always encoded at a real constant bitrate (default 320 kbps; MP3 uses true CBR via matching `-b:a/-minrate/-maxrate`). SoundCloud only serves a ~128 kbps source, but the delivered file now advertises the target bitrate in its metadata, so a bitrate checker / file-properties dialog shows 320 kbps — stopping "low bitrate" refund disputes. WAV/FLAC are unchanged (lossless).
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
