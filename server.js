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

// Stream/download the track as MP3
app.get("/download", (req, res) => {
  const url = req.query.url;
  const title = req.query.title || "track";

  if (!url || !url.includes("soundcloud.com")) {
    return res.status(400).json({ error: "Invalid SoundCloud URL" });
  }

  const safeTitle = title.replace(/[^a-zA-Z0-9_\- ]/g, "").trim() || "track";

  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp3"`);
  res.setHeader("Content-Type", "audio/mpeg");

  const ytdlp = spawn("yt-dlp", [
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "0",
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
