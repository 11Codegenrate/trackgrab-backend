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

// Map one yt-dlp track object to the frontend "track" shape.
function trackShape(t) {
  return {
    title: t.title || "",
    url: t.webpage_url || t.url || t.original_url || "",
    uploader: t.uploader || "",
    duration: typeof t.duration === "number" ? t.duration : null,
    thumbnail: bestThumb(t),
  };
}

// Get track info, or a playlist. yt-dlp --dump-json emits ONE JSON object per
// line: a single line for a track, one line per track for a /sets/ playlist.
app.get("/info", (req, res) => {
  const url = req.query.url;
  if (!url || !url.includes("soundcloud.com")) {
    return res.status(400).json({ error: "Invalid SoundCloud URL" });
  }

  exec(
    `yt-dlp --dump-json --no-playlist --no-warnings "${url}"`,
    { timeout: 90000, maxBuffer: 64 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        console.error("yt-dlp info error:", stderr);
        return res.status(500).json({ error: "Could not fetch track info" });
      }

      const lines = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let items;
      try {
        items = lines.map((l) => JSON.parse(l));
      } catch (e) {
        return res.status(500).json({ error: "Failed to parse track data" });
      }
      if (!items.length) {
        return res.status(500).json({ error: "No track data" });
      }

      // Multiple objects → a playlist / set.
      if (items.length > 1) {
        const first = items[0];
        return res.json({
          type: "playlist",
          header: {
            playlist_title: first.playlist_title || first.album || first.playlist || "Playlist",
            uploader: first.playlist_uploader || first.album_artist || "",
            uploader_url: "",
            thumbnail: bestThumb(first),
          },
          total: items.length,
          tracks: items.map(trackShape),
        });
      }

      // Single track — original response shape (unchanged).
      const data = items[0];
      res.json({
        title: data.title,
        uploader: data.uploader,
        thumbnail: data.thumbnail,
        duration: data.duration,
        description: data.description,
        like_count: data.like_count,
        view_count: data.view_count,
        url: url,
      });
    }
  );
});

// Supported formats → yt-dlp extraction args, download-name extension, MIME type.
// SoundCloud is audio-only, so mp4/m4a both resolve to an MP4 (ISO) audio container.
const DOWNLOAD_FORMATS = {
  mp3:  { args: ["-x", "--audio-format", "mp3",  "--audio-quality", "0"], ext: "mp3",  mime: "audio/mpeg" },
  m4a:  { args: ["-x", "--audio-format", "m4a",  "--audio-quality", "0"], ext: "m4a",  mime: "audio/mp4"  },
  mp4:  { args: ["-x", "--audio-format", "m4a",  "--audio-quality", "0"], ext: "mp4",  mime: "audio/mp4"  },
  wav:  { args: ["-x", "--audio-format", "wav"],                          ext: "wav",  mime: "audio/wav"  },
  flac: { args: ["-x", "--audio-format", "flac"],                         ext: "flac", mime: "audio/flac" },
};

// Download in the requested audio format.
// yt-dlp's format conversion is a post-processor that needs a real file to work
// on — piping to stdout (-o -) skips it and streams SoundCloud's raw source
// (usually M4A) instead. So we convert to a temp file, stream it, then delete it.
app.get("/download", (req, res) => {
  const url = req.query.url;
  const title = req.query.title || "track";
  const requested = String(req.query.format || "mp3").toLowerCase();
  const fmt = DOWNLOAD_FORMATS[requested] || DOWNLOAD_FORMATS.mp3;

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

  const ytdlp = spawn("yt-dlp", [
    ...fmt.args,
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
  });

  ytdlp.on("close", (code) => {
    // Find whatever file yt-dlp actually produced (e.g. mp4 → .m4a).
    let produced = null;
    try {
      const dir = os.tmpdir();
      const match = fs.readdirSync(dir).find((f) => f.startsWith(prefix + "."));
      if (match) produced = path.join(dir, match);
    } catch (e) {}

    if (code !== 0 || !produced) {
      console.error("yt-dlp failed (code " + code + "):", stderr);
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: "Conversion failed" });
      return;
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
    });
    stream.on("close", cleanup);
    stream.pipe(res);
  });

  // Client aborted before we finished — stop yt-dlp and clean up.
  req.on("close", () => {
    if (ytdlp.exitCode === null) ytdlp.kill();
    cleanup();
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`TrackGrab server running on port ${PORT}`));
