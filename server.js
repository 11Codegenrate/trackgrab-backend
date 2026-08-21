const express = require("express");
const cors = require("cors");
const { exec, spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const app = express();

app.use(cors());
app.use(express.json());

// Audio conversion routes (/probe, /convert) used by the SCloud Audio Converter.
app.use(require("./convert"));

// Health check — keeps the process reachable (ping this to verify it's up).
app.get("/", (req, res) => {
  res.json({ status: "TrackGrab server is running ✅" });
});

// Largest usable thumbnail URL from a yt-dlp info object.
function bestThumb(obj) {
  if (!obj) return "";
  if (typeof obj.thumbnail === "string" && obj.thumbnail) return obj.thumbnail;
  const arr = Array.isArray(obj.thumbnails) ? obj.thumbnails : [];
  let best = "", bestW = -1;
  for (const t of arr) {
    if (t && t.url && typeof t.width === "number" && t.width > bestW) { best = t.url; bestW = t.width; }
  }
  if (best) return best;
  for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] && arr[i].url) return arr[i].url; }
  return "";
}

// Humanize a SoundCloud track slug into a title (SC permalinks come from the
// title): ".../you-prod-saint-mike" -> "You Prod Saint Mike".
function titleFromUrl(u) {
  try {
    const parts = new URL(u).pathname.split("/").filter(Boolean);
    let slug = parts.length ? parts[parts.length - 1] : "";
    slug = decodeURIComponent(slug).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!slug) return "";
    return slug.replace(/\b\w/g, (c) => c.toUpperCase());
  } catch (e) {
    return "";
  }
}

// Map one flat-playlist entry to the frontend "track" shape.
function flatTrackShape(e) {
  const turl = e.url || e.webpage_url || "";
  return {
    title: e.title || titleFromUrl(turl),
    url: turl,
    uploader: e.uploader || "",
    duration: typeof e.duration === "number" ? e.duration : null,
    thumbnail: bestThumb(e),
  };
}

// Get track info, or a playlist. One yt-dlp call: --flat-playlist means a
// /sets/ URL returns the playlist with a lightweight entries[] list (1 request
// to SoundCloud) instead of resolving all 50 tracks (which gets rate-limited).
// A single-track URL returns its full metadata (flat-playlist is a no-op there).
app.get("/info", (req, res) => {
  const url = req.query.url;
  if (!url || !url.includes("soundcloud.com")) {
    return res.status(400).json({ error: "Invalid SoundCloud URL" });
  }

  exec(
    `yt-dlp -J --flat-playlist --no-playlist --no-warnings "${url}"`,
    { timeout: 45000, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        console.error("yt-dlp info error:", stderr);
        return res.status(500).json({ error: "Could not fetch track info" });
      }

      let meta;
      try {
        meta = JSON.parse(stdout);
      } catch (e) {
        return res.status(500).json({ error: "Failed to parse track data" });
      }
      if (!meta) {
        return res.status(500).json({ error: "No track data" });
      }

      // Playlist / set.
      if (Array.isArray(meta.entries)) {
        const tracks = meta.entries
          .filter((e) => e && (e.url || e.webpage_url))
          .map(flatTrackShape);
        return res.json({
          type: "playlist",
          header: {
            playlist_title: meta.title || meta.album || "Playlist",
            uploader: meta.uploader || meta.album_artist || "",
            uploader_url: meta.uploader_url || "",
            thumbnail: bestThumb(meta),
          },
          total: meta.playlist_count || tracks.length,
          tracks: tracks,
        });
      }

      // Single track — original response shape (unchanged).
      res.json({
        title: meta.title,
        uploader: meta.uploader,
        thumbnail: meta.thumbnail,
        duration: meta.duration,
        description: meta.description,
        like_count: meta.like_count,
        view_count: meta.view_count,
        url: url,
      });
    }
  );
});

// Supported formats → yt-dlp target audio format, download-name extension, MIME.
// SoundCloud is audio-only, so mp4/m4a both resolve to an MP4 (ISO) audio container.
// `lossless` formats (WAV/FLAC) ignore bitrate; `canEmbed` = format supports tags/cover
// (WAV has no usable tag container, so metadata embedding is skipped there).
const DOWNLOAD_FORMATS = {
  mp3:  { audioFormat: "mp3",  ext: "mp3",  mime: "audio/mpeg", lossless: false, canEmbed: true  },
  m4a:  { audioFormat: "m4a",  ext: "m4a",  mime: "audio/mp4",  lossless: false, canEmbed: true  },
  mp4:  { audioFormat: "m4a",  ext: "mp4",  mime: "audio/mp4",  lossless: false, canEmbed: true  },
  wav:  { audioFormat: "wav",  ext: "wav",  mime: "audio/wav",  lossless: true,  canEmbed: false },
  flac: { audioFormat: "flac", ext: "flac", mime: "audio/flac", lossless: true,  canEmbed: true  },
};

// Clamp a requested MP3 bitrate to a sane CBR value; "" means "let yt-dlp pick best".
function normalizeBitrate(raw) {
  const n = parseInt(String(raw || ""), 10);
  if (!Number.isFinite(n)) return "";
  if (n < 64) return "64";
  if (n > 320) return "320";
  return String(n);
}

// Build the yt-dlp argument list for a format + plan-derived options.
// - bitrate: lossy formats encode CBR at "<bitrate>K"; lossless ignore it.
// - meta: embed title/artist/etc. tags and cover art (where the container supports it).
function buildYtdlpArgs(fmt, opts) {
  const args = ["-x", "--audio-format", fmt.audioFormat];

  if (!fmt.lossless) {
    // "<n>K" tells ffmpeg to target that exact bitrate; "0" = best VBR.
    args.push("--audio-quality", opts.bitrate ? `${opts.bitrate}K` : "0");
  }

  if (opts.meta && fmt.canEmbed) {
    // Tags (ID3/MP4/Vorbis comments) are reliable on every container we allow.
    args.push("--embed-metadata");
    // Cover-art embedding is only reliable for the lossy containers. Embedding a
    // picture into FLAC via ffmpeg can fail the whole job, so skip the thumbnail
    // there (tags still applied). --convert-thumbnails jpg avoids webp rejection.
    if (!fmt.lossless) {
      args.push("--embed-thumbnail", "--convert-thumbnails", "jpg");
    }
  }

  return args;
}

// ── Priority-aware job queue ────────────────────────────────────────────────
// Bounds concurrent yt-dlp/ffmpeg jobs so the box stays responsive, and lets
// Pro ("priority") downloads jump ahead of the free queue — the server side of
// "priority server queue / faster processing". Tune with MAX_CONCURRENT env.
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT || "3", 10) || 3);
let activeJobs = 0;
const jobQueue = []; // { priority: 0|1, run: (release) => void }

function pumpQueue() {
  while (activeJobs < MAX_CONCURRENT && jobQueue.length) {
    const job = jobQueue.shift();
    activeJobs++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeJobs--;
      pumpQueue();
    };
    try {
      job.run(release);
    } catch (e) {
      console.error("job run error:", e);
      release();
    }
  }
}

function scheduleJob(priority, run) {
  const job = { priority: priority ? 1 : 0, run };
  if (job.priority) {
    // Insert ahead of all normal jobs, behind any waiting priority jobs (FIFO within a tier).
    let i = 0;
    while (i < jobQueue.length && jobQueue[i].priority >= job.priority) i++;
    jobQueue.splice(i, 0, job);
  } else {
    jobQueue.push(job);
  }
  pumpQueue();
}

// Download in the requested audio format.
// yt-dlp's format conversion is a post-processor that needs a real file to work
// on — piping to stdout (-o -) skips it and streams SoundCloud's raw source
// (usually M4A) instead. So we convert to a temp file, stream it, then delete it.
app.get("/download", (req, res) => {
  const url = req.query.url;
  const title = req.query.title || "track";
  const requested = String(req.query.format || "mp3").toLowerCase();
  const fmt = DOWNLOAD_FORMATS[requested] || DOWNLOAD_FORMATS.mp3;

  // Plan-derived options passed by the WP plugin's signed URL.
  const opts = {
    bitrate: normalizeBitrate(req.query.bitrate),
    meta: String(req.query.meta || "") === "1",
  };
  const priority = String(req.query.priority || "") === "1";

  if (!url || !url.includes("soundcloud.com")) {
    return res.status(400).json({ error: "Invalid SoundCloud URL" });
  }

  const safeTitle = title.replace(/[^a-zA-Z0-9_\- ]/g, "").trim() || "track";
  const workId = crypto.randomBytes(8).toString("hex");
  const prefix = `trackgrab-${workId}`;
  const outTemplate = path.join(os.tmpdir(), `${prefix}.%(ext)s`);

  function cleanup() {
    try {
      const dir = os.tmpdir();
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(prefix)) {
          try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  scheduleJob(priority, (release) => {
    // Client already gone before the slot opened — drop the job.
    if (res.writableEnded || req.destroyed) {
      cleanup();
      release();
      return;
    }

    // Free the queue slot exactly once, whenever this response is fully done.
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      release();
    };
    res.on("finish", releaseSlot);
    res.on("close", releaseSlot);

    const ytdlp = spawn("yt-dlp", [
      ...buildYtdlpArgs(fmt, opts),
      "-o", outTemplate,
      "--no-playlist",
      "--no-progress",
      url,
    ]);

    let stderr = "";
    ytdlp.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    ytdlp.on("error", (err) => {
      console.error("spawn error:", err);
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: "Download failed" });
      releaseSlot();
    });

    ytdlp.on("close", (code) => {
      // Find the finished audio yt-dlp produced. Prefer the exact target extension
      // (mp4 resolves to .m4a), and never pick an in-progress ".part" fragment.
      let produced = null;
      try {
        const dir = os.tmpdir();
        const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix + "."));
        const exact = files.find((f) => f === prefix + "." + fmt.ext);
        const pick = exact || files.find((f) => !f.endsWith(".part"));
        if (pick) produced = path.join(dir, pick);
      } catch (e) {}

      // No finished audio at all → genuine conversion failure.
      if (!produced) {
        console.error("yt-dlp failed (code " + code + "), no output:", stderr);
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: "Conversion failed" });
        releaseSlot();
        return;
      }

      // Non-zero exit but the finished file exists → a post-processing step (e.g.
      // cover-art embed) failed after the audio was ready. Serve the audio anyway
      // rather than denying the download over a cosmetic tagging error.
      if (code !== 0) {
        console.warn("yt-dlp exited " + code + " but output exists; serving anyway. stderr:", stderr);
      }

      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.${fmt.ext}"`);
      res.setHeader("Content-Type", fmt.mime);
      try {
        res.setHeader("Content-Length", fs.statSync(produced).size);
      } catch (e) {}

      const stream = fs.createReadStream(produced);
      stream.on("error", () => {
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: "Read failed" });
        releaseSlot();
      });
      stream.on("close", cleanup);
      stream.pipe(res);
    });

    // Client aborted before we finished — stop yt-dlp and clean up.
    req.on("close", () => {
      if (ytdlp.exitCode === null) ytdlp.kill();
      cleanup();
      releaseSlot();
    });
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`TrackGrab server running on port ${PORT}`));
