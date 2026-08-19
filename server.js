const express = require("express");
const cors = require("cors");
const { exec, spawn } = require("child_process");
const app = express();

app.use(cors());
app.use(express.json());

// Health check — keeps Render from sleeping (ping this every 5 mins)
app.get("/", (req, res) => {
  res.json({ status: "TrackGrab server is running ✅" });
});

// Get track info (title, artwork, duration)
app.get("/info", async (req, res) => {
  const url = req.query.url;
  if (!url || !url.includes("soundcloud.com")) {
    return res.status(400).json({ error: "Invalid SoundCloud URL" });
  }

  exec(
    `yt-dlp --dump-json --no-playlist "${url}"`,
    { timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) {
        console.error("yt-dlp info error:", stderr);
        return res.status(500).json({ error: "Could not fetch track info" });
      }
      try {
        const data = JSON.parse(stdout);
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
      } catch (e) {
        res.status(500).json({ error: "Failed to parse track data" });
      }
    }
  );
});

// Supported download formats → yt-dlp extraction args, file extension, MIME type.
// SoundCloud is audio-only, so mp4/m4a resolve to an ISO (MP4) audio container.
const DOWNLOAD_FORMATS = {
  mp3:  { args: ["-x", "--audio-format", "mp3",  "--audio-quality", "0"], ext: "mp3",  mime: "audio/mpeg" },
  m4a:  { args: ["-x", "--audio-format", "m4a",  "--audio-quality", "0"], ext: "m4a",  mime: "audio/mp4"  },
  mp4:  { args: ["-x", "--audio-format", "m4a",  "--audio-quality", "0"], ext: "mp4",  mime: "audio/mp4"  },
  wav:  { args: ["-x", "--audio-format", "wav"],                          ext: "wav",  mime: "audio/wav"  },
  flac: { args: ["-x", "--audio-format", "flac"],                         ext: "flac", mime: "audio/flac" },
};

// Stream/download the track in the requested audio format (defaults to MP3).
app.get("/download", (req, res) => {
  const url = req.query.url;
  const title = req.query.title || "track";
  const requested = String(req.query.format || "mp3").toLowerCase();
  const fmt = DOWNLOAD_FORMATS[requested] || DOWNLOAD_FORMATS.mp3;

  if (!url || !url.includes("soundcloud.com")) {
    return res.status(400).json({ error: "Invalid SoundCloud URL" });
  }

  const safeTitle = title.replace(/[^a-zA-Z0-9_\- ]/g, "").trim() || "track";

  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.${fmt.ext}"`);
  res.setHeader("Content-Type", fmt.mime);

  const ytdlp = spawn("yt-dlp", [
    ...fmt.args,
    "-o", "-",       // output to stdout
    "--no-playlist",
    url,
  ]);

  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on("data", (data) => {
    console.error("yt-dlp:", data.toString());
  });

  ytdlp.on("error", (err) => {
    console.error("spawn error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Download failed" });
    }
  });

  req.on("close", () => {
    ytdlp.kill();
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`TrackGrab server running on port ${PORT}`));
