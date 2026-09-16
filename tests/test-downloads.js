"use strict";

// Offline regressions for the failures seen in the VPS logs. No request reaches
// SoundCloud, and every process fixture uses the current local Node runtime.
const test = require("node:test");
const assert = require("node:assert/strict");
const { runTool } = require("../process-runner");
const { classifyDownloadError, sendDownloadError } = require("../download-errors");

test("process runner reads both streams and records a successful exit", async () => {
  const result = await runTool(process.execPath, ["-e", "process.stdout.write('ready'); process.stderr.write('warning')"], { timeoutMs: 5000 });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "ready");
  assert.equal(result.stderr, "warning");
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test("a nonzero child exit is preserved with its diagnostic", async () => {
  const result = await runTool(process.execPath, ["-e", "process.stderr.write('ERROR: Interrupted by user'); process.exit(1)"], { timeoutMs: 5000 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Interrupted by user/);
});

test("output is drained and capped rather than filling an unread pipe", async () => {
  const result = await runTool(process.execPath, ["-e", "process.stdout.write('x'.repeat(200000)); process.stderr.write('y'.repeat(200000))"], { timeoutMs: 5000, maxOutput: 1024 });
  assert.equal(result.code, 0);
  assert.ok(result.stdout.length > 0 && result.stdout.length <= 1024);
  assert.ok(result.stderr.length > 0 && result.stderr.length <= 1024);
});

test("a hung child is terminated and identified as a timeout", async () => {
  const result = await runTool(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 150 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test("request cancellation terminates the child and is kept separate from failure", async () => {
  const controller = new AbortController();
  const pending = runTool(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 5000, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 150);
  const result = await pending;
  clearTimeout(timer);
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
});

test("missing tool errors settle instead of hanging or throwing", async () => {
  const result = await runTool(`trackgrab-missing-binary-${process.pid}`, [], { timeoutMs: 1000 });
  assert.equal(result.error && result.error.code, "ENOENT");
  assert.notEqual(result.code, 0);
});

const classifications = [
  ["exact geo restriction wording from VPS", "ERROR: [soundcloud] This video is not available from your location due to geo restriction\nYou might want to use a VPN or a proxy server (with --proxy) to workaround.", {}, "geo_restricted", false],
  ["exact DRM wording from VPS", "WARNING: [soundcloud] 2363103443: hls_mp3 format not found\nWARNING: [soundcloud] 2363103443: http_mp3 format not found\nERROR: [soundcloud] 2363103443: This video is DRM protected", {}, "drm_protected", false],
  ["explicit child interruption", "ERROR: Interrupted by user", {}, "download_interrupted", true],
  ["signal exit with empty stderr", "", { signal: "SIGTERM" }, "download_interrupted", true],
  ["deadline exceeded", "", { timedOut: true }, "download_timeout", true],
  ["HTTP rate limit", "ERROR: HTTP Error 429: Too Many Requests", {}, "rate_limited", true],
  ["unavailable HLS fragment", "ERROR: fragment 42 not found, unable to continue", {}, "upstream_unavailable", true],
  ["subscription preview", "ERROR: This track is only available as a preview for SoundCloud Go+", {}, "preview_only", false],
  ["missing downloader", "", { error: { code: "ENOENT" } }, "tool_missing", false],
];

for (const [name, stderr, context, code, retryable] of classifications) {
  test(`classifies ${name}`, () => {
    const info = classifyDownloadError(stderr, context);
    assert.equal(info.code, code);
    assert.equal(info.retryable, retryable);
    assert.ok(info.status >= 400 && info.status <= 599);
    assert.ok(info.message.length > 0);
  });
}

test("structured errors keep the existing frontend fields", () => {
  const info = classifyDownloadError("ERROR: HTTP Error 429: Too Many Requests");
  let sent;
  const res = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this[name] = value; return this; },
    set(name, value) { this[name] = value; return this; },
    json(value) { sent = value; return this; },
  };
  sendDownloadError(res, info);
  assert.equal(res.statusCode, info.status);
  for (const key of ["error", "code", "category", "message", "hint", "retryable"]) assert.ok(Object.hasOwn(sent, key), key);
  assert.equal(sent.code, "rate_limited");
});

test("HTTP download regressions use the real queue and temporary files", { timeout: 30000 }, async (t) => {
  const http = require("node:http");
  const fs = require("node:fs");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const runnerModule = require("../process-runner");
  const originalRunner = runnerModule.runTool;
  const sharedSecret = "trackgrab-offline-test-secret";
  const oldEnv = {};
  const settings = { SCLOUD_API_SECRET: sharedSecret, SCLOUD_API_OPEN: "0", MAX_CONCURRENT: "1", MAX_QUEUE: "5", DOWNLOAD_ATTEMPTS: "2", DOWNLOAD_RETRY_DELAY_MS: "0" };
  for (const [key, value] of Object.entries(settings)) {
    oldEnv[key] = process.env[key];
    process.env[key] = value;
  }
  const audio = Buffer.from("offline complete audio fixture");
  const plans = [];
  const probePlans = [];
  const calls = [];
  const directories = new Set();
  const incoming = new Map();
  let activeChildren = 0;
  let largestActiveChildren = 0;

  const okResult = (values = {}) => ({ code: 0, signal: null, stdout: "", stderr: "", error: null, timedOut: false, aborted: false, ...values });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(message);
      await pause(10);
    }
  };
  const gate = () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    return { pending, release };
  };

  runnerModule.runTool = async (command, args, options = {}) => {
    if (args.includes("-show_entries")) {
      if (probePlans.length) return probePlans.shift();
      const input = args[args.length - 1];
      const ext = path.extname(input).slice(1);
      const format = { mp3: "mp3", m4a: "mov,mp4,m4a,3gp,3g2,mj2", mp4: "mov,mp4,m4a,3gp,3g2,mj2", wav: "wav", flac: "flac" }[ext];
      const codec = { mp3: "mp3", m4a: "aac", mp4: "aac", wav: "pcm_s16le", flac: "flac" }[ext];
      return okResult({ stdout: JSON.stringify({ format: { format_name: format, duration: "10.0" }, streams: [{ codec_type: "audio", codec_name: codec, duration: "10.0" }] }) });
    }
    if (args.includes("--version") || args.includes("-version")) return okResult({ stdout: "offline test tool" });
    const plan = plans.shift();
    assert.ok(plan, "unexpected yt-dlp invocation");
    calls.push({ command, args: [...args], plan });
    activeChildren++;
    largestActiveChildren = Math.max(largestActiveChildren, activeChildren);
    try {
      if (plan.gate) {
        let removeAbort = () => {};
        const stopped = new Promise((resolve) => {
          if (options.signal && options.signal.aborted) return resolve("aborted");
          const stop = () => resolve("aborted");
          if (options.signal) {
            options.signal.addEventListener("abort", stop, { once: true });
            removeAbort = () => options.signal.removeEventListener("abort", stop);
          }
        });
        const outcome = await Promise.race([plan.gate.pending.then(() => "ready"), stopped]);
        removeAbort();
        if (outcome === "aborted") {
          plan.wasAborted = true;
          return okResult({ code: null, signal: "SIGTERM", aborted: true });
        }
      }
      if (args.includes("-J")) {
        assert.ok(plan.metadata, "info must use a metadata fixture");
        return okResult({ stdout: JSON.stringify(plan.metadata) });
      }
      let output = "";
      if (plan.write !== false) {
        const outputIndex = args.indexOf("-o");
        assert.ok(outputIndex >= 0, "download must use a file output template");
        const ext = plan.outputExt || args[args.indexOf("--audio-format") + 1];
        output = args[outputIndex + 1].replace(/%\(ext\)s/g, ext);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        directories.add(path.dirname(output));
        fs.writeFileSync(output, plan.bytes || audio);
      }
      return okResult({ stdout: output ? `TRACKGRAB_FILE:${output}\n` : "", ...plan.result });
    } finally {
      activeChildren--;
    }
  };

  let server;
  try {
    const { app } = require("../server");
    server = http.createServer((req, res) => {
      // Consume the GET request normally. IncomingMessage.destroyed becomes true
      // after consumption on modern Node, even while its response remains open.
      incoming.set(req.url, req);
      req.resume();
      app(req, res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const signedPath = (values = {}, version = "2") => {
      const q = {
        url: "https://soundcloud.com/test-author/test-track", format: "mp3", title: "Test track",
        exp: String(Math.floor(Date.now() / 1000) + 3600), bitrate: "320", meta: "0", priority: "0", ...values,
      };
      if (version === "2") q.v = "2";
      let payload = [q.url, q.format, q.title, q.exp].join("\n");
      if (version === "2") payload += `\n${q.bitrate || ""}\n${q.meta || ""}\n${q.priority || ""}`;
      else {
        if (q.bitrate) payload += `\n${q.bitrate}`;
        if (q.meta) payload += `\n${q.meta}`;
      }
      q.sig = crypto.createHmac("sha256", sharedSecret).update(payload).digest("hex");
      return `/download?${new URLSearchParams(q)}`;
    };
    const request = (requestPath, headers = {}) => {
      let req;
      const pending = new Promise((resolve, reject) => {
        req = http.get({ host: "127.0.0.1", port, path: requestPath, headers }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        });
        req.on("error", reject);
      });
      return { req, pending };
    };
    const reset = () => {
      assert.equal(activeChildren, 0);
      assert.equal(plans.length, 0);
      assert.equal(probePlans.length, 0);
      calls.length = 0;
      incoming.clear();
      largestActiveChildren = 0;
    };

    await t.test("flat playlist results retain permalink and API-only SoundCloud entries", async () => {
      const entries = Array.from({ length: 21 }, (_, index) => ({
        _type: "url_transparent", ie_key: "Soundcloud", id: String(2363103443 + index),
        url: index < 5 ? `https://soundcloud.com/artist/test-track-${index + 1}` :
          `https://api-v2.soundcloud.com/tracks/${2363103443 + index}`,
        album: "Underground Italia Hip-Hop", album_artist: "SoundCloud Playlists", album_type: "playlist",
      }));
      plans.push({ metadata: { _type: "playlist", id: "2467762451", title: "Underground Italia Hip-Hop",
        uploader: "SoundCloud Playlists", playlist_count: 21, entries } });
      const result = await request(`/info?${new URLSearchParams({
        url: "https://soundcloud.com/playlist/sets/underground-italia-hip-hop",
      })}`, { "X-API-Key": sharedSecret }).pending;
      assert.equal(result.status, 200);
      const data = JSON.parse(result.body);
      assert.equal(data.type, "playlist");
      assert.equal(data.total, 21);
      assert.equal(data.tracks.length, 21);
      assert.equal(data.header.playlist_title, "Underground Italia Hip-Hop");
      assert.deepEqual(data.tracks.map((track) => track.url), entries.map((entry) => entry.url));
      assert.equal(data.tracks[0].title, "Test Track 1");
      assert.equal(data.tracks[5].title, entries[5].id);
      assert.ok(data.tracks.every((track) => track.title.length > 0));
      assert.ok(calls[0].args.includes("--flat-playlist"));
      reset();
    });

    await t.test("a pure playlist cannot enter a single-track download job", async () => {
      for (const url of [
        "https://soundcloud.com/playlist/sets/underground-italia-hip-hop",
        "https://www.soundcloud.com/artist/sets/my-playlist/private-token",
        "https://api.soundcloud.com/playlists/2467762451",
        "https://api-v2.soundcloud.com/playlists/2467762451?secret_token=private-token",
      ]) {
        const result = await request(signedPath({ url })).pending;
        assert.equal(result.status, 400);
        const data = JSON.parse(result.body);
        assert.equal(data.code, "playlist_requires_tracks");
        assert.equal(data.category, "playlist");
        assert.equal(data.retryable, false);
        assert.equal(data.error, "This link is a playlist. Choose a track from the results to download.");
      }
      assert.equal(calls.length, 0);
      reset();
    });

    await t.test("a track link with playlist context still downloads normally", async () => {
      plans.push({});
      const result = await request(signedPath({
        url: "https://soundcloud.com/artist/test-track?in=playlist/sets/underground-italia-hip-hop",
      })).pending;
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, audio);
      assert.equal(calls.length, 1);
      reset();
    });

    await t.test("all supported output formats retain their filenames and MIME types", async () => {
      const formats = { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", wav: "audio/wav", flac: "audio/flac" };
      for (const [format, mime] of Object.entries(formats)) {
        plans.push({});
        const result = await request(signedPath({ format })).pending;
        assert.equal(result.status, 200);
        assert.equal(result.headers["content-type"], mime);
        assert.match(result.headers["content-disposition"], new RegExp(`Test track\\.${format}`));
        assert.deepEqual(result.body, audio);
      }
      assert.equal(calls.length, 5);
      reset();
    });

    await t.test("a healthy queued GET is kept after its request stream is destroyed", async () => {
      const held = gate();
      plans.push({ gate: held }, {});
      const first = request(signedPath({ title: "Held" }));
      await waitFor(() => calls.length === 1, "first download did not start");
      const secondPath = signedPath({ title: "Queued" });
      const second = request(secondPath);
      await waitFor(() => incoming.get(secondPath)?.destroyed, "queued request body was not consumed");
      assert.equal(incoming.get(secondPath).complete, true);
      held.release();
      assert.equal((await first.pending).status, 200);
      assert.equal((await second.pending).status, 200);
      assert.equal(calls.length, 2);
      assert.equal(largestActiveChildren, 1);
      reset();
    });

    await t.test("signal exits never deliver an existing partial audio file", async () => {
      plans.push({ result: { code: null, signal: "SIGKILL" } }, { result: { code: null, signal: "SIGKILL" } });
      const result = await request(signedPath()).pending;
      assert.ok(result.status >= 400);
      assert.equal(JSON.parse(result.body).code, "download_interrupted");
      assert.equal(result.headers["content-disposition"], undefined);
      assert.equal(calls.length, 2);
      reset();
    });

    await t.test("explicit interruption never delivers an existing partial file", async () => {
      plans.push({ result: { code: 1, stderr: "ERROR: Interrupted by user" } }, { result: { code: 1, stderr: "ERROR: Interrupted by user" } });
      const result = await request(signedPath()).pending;
      assert.ok(result.status >= 400);
      assert.equal(JSON.parse(result.body).code, "download_interrupted");
      assert.equal(result.headers["content-disposition"], undefined);
      reset();
    });

    await t.test("an output file without the completed postprocessing marker is rejected", async () => {
      plans.push({ result: { stdout: "" } });
      const result = await request(signedPath()).pending;
      assert.ok(result.status >= 400);
      assert.equal(result.headers["content-disposition"], undefined);
      assert.notDeepEqual(result.body, audio);
      reset();
    });

    await t.test("a completed thumbnail cannot be mistaken for the requested audio", async () => {
      plans.push({ outputExt: "jpg" });
      const result = await request(signedPath({ format: "mp4", meta: "1" })).pending;
      assert.ok(result.status >= 400);
      assert.equal(result.headers["content-disposition"], undefined);
      assert.notDeepEqual(result.body, audio);
      reset();
    });

    await t.test("wrong codec or container is rejected before attachment headers are set", async () => {
      plans.push({});
      probePlans.push(okResult({ stdout: JSON.stringify({ format: { format_name: "wav" }, streams: [{ codec_type: "audio", codec_name: "pcm_s16le" }] }) }));
      const result = await request(signedPath({ format: "mp3" })).pending;
      assert.equal(result.status, 502);
      assert.equal(JSON.parse(result.body).code, "invalid_output");
      assert.equal(result.headers["content-disposition"], undefined);
      reset();
    });

    for (const [name, stderr, code] of [
      ["geo restriction", classifications[0][1], "geo_restricted"],
      ["DRM protection", classifications[1][1], "drm_protected"],
    ]) {
      await t.test(`${name} is specific and is not retried`, async () => {
        plans.push({ write: false, result: { code: 1, stderr } });
        const result = await request(signedPath()).pending;
        assert.ok(result.status >= 400);
        assert.equal(JSON.parse(result.body).code, code);
        assert.equal(calls.length, 1);
        reset();
      });
    }

    await t.test("a transient rate limit gets one bounded retry", async () => {
      plans.push({ write: false, result: { code: 1, stderr: "ERROR: HTTP Error 429: Too Many Requests" } }, {});
      const result = await request(signedPath()).pending;
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, audio);
      assert.equal(calls.length, 2);
      reset();
    });

    await t.test("failed cover embedding retries cleanly with metadata disabled", async () => {
      plans.push({ result: { code: 1, stderr: "ERROR: Postprocessing: EmbedThumbnail failed to embed cover artwork" } }, {});
      const result = await request(signedPath({ meta: "1" })).pending;
      assert.equal(result.status, 200);
      assert.ok(calls[0].args.includes("--embed-thumbnail"));
      assert.ok(!calls[1].args.includes("--embed-thumbnail"));
      assert.ok(!calls[1].args.includes("--embed-metadata"));
      assert.deepEqual(result.body, audio);
      reset();
    });

    await t.test("disconnecting a waiting client does not start its download", async () => {
      const held = gate();
      plans.push({ gate: held }, {});
      const first = request(signedPath({ title: "Active" }));
      await waitFor(() => calls.length === 1, "active download did not start");
      const abandonedPath = signedPath({ title: "Abandoned" });
      const abandoned = request(abandonedPath);
      abandoned.pending.catch(() => {});
      await waitFor(() => incoming.has(abandonedPath), "waiting download was not received");
      abandoned.req.destroy();
      const thirdPath = signedPath({ title: "Next" });
      const next = request(thirdPath);
      await waitFor(() => incoming.has(thirdPath), "next download was not received");
      held.release();
      assert.equal((await first.pending).status, 200);
      assert.equal((await next.pending).status, 200);
      assert.equal(calls.length, 2);
      assert.ok(calls.every((call) => !call.args.includes("Abandoned")));
      reset();
    });

    await t.test("active disconnect stops its child before the next queue slot opens", async () => {
      const held = gate();
      const stoppedPlan = { gate: held };
      plans.push(stoppedPlan, {});
      const active = request(signedPath({ title: "Cancel active" }));
      active.pending.catch(() => {});
      await waitFor(() => calls.length === 1, "active download did not start");
      const nextPath = signedPath({ title: "After cancel" });
      const next = request(nextPath);
      await waitFor(() => incoming.has(nextPath), "queued download was not received");
      active.req.destroy();
      assert.equal((await next.pending).status, 200);
      assert.equal(stoppedPlan.wasAborted, true);
      assert.equal(largestActiveChildren, 1);
      assert.equal(calls.length, 2);
      reset();
    });

    await t.test("legacy and V2 signed links remain compatible", async () => {
      plans.push({}, {});
      assert.equal((await request(signedPath({}, "1")).pending).status, 200);
      assert.equal((await request(signedPath()).pending).status, 200);
      reset();
    });

    await t.test("V2 plan fields cannot be changed without a new signature", async () => {
      for (const [field, value] of [["bitrate", "64"], ["meta", "1"], ["priority", "1"]]) {
        const requestUrl = new URL(signedPath(), "http://localhost");
        requestUrl.searchParams.set(field, value);
        const result = await request(`${requestUrl.pathname}${requestUrl.search}`).pending;
        assert.equal(result.status, 403);
        assert.equal(JSON.parse(result.body).code, "bad_link");
      }
      assert.equal(calls.length, 0);
      reset();
    });

    await waitFor(() => [...directories].every((dir) => !fs.existsSync(dir)), "temporary download directories were not cleaned");
  } finally {
    runnerModule.runTool = originalRunner;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});
