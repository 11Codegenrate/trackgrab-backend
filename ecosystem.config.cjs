module.exports = {
  apps: [
    {
      name: "trackgrab",
      script: "./server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      restart_delay: 3000,
      max_memory_restart: "700M",
      kill_timeout: 12000,
      listen_timeout: 10000,
      time: true,
      env: {
        NODE_ENV: "production",
        PORT: "3001",
        MAX_CONCURRENT: "2",
        MAX_QUEUE: "30",
        DOWNLOAD_TIMEOUT_S: "900",
        YTDLP_FRAGMENTS: "4",
        CONVERT_MAX_MB: "500",
        CONVERT_CONCURRENCY: "1",
        CONVERT_TIMEOUT_S: "600",
        M4A_BITRATE: "128",
      },
    },
  ],
};
