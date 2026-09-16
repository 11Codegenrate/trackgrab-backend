const { spawn } = require("child_process");

// Always drain both pipes. Keep a job's slot until the process and its pipes close,
// including after a timeout or cancellation. On Linux, terminate FFmpeg too.
function runTool(command, args, options = {}) {
  const { signal, timeoutMs = 30000, maxOutput = 65536 } = options;
  if (signal?.aborted) {
    return Promise.resolve({ code: null, signal: null, stdout: "", stderr: "", error: null, timedOut: false, aborted: true });
  }
  return new Promise((resolve) => {
    let child, timer;
    const result = { code: null, signal: null, stdout: "", stderr: "", error: null, timedOut: false, aborted: false };
    const append = (key, data) => { result[key] = (result[key] + data.toString()).slice(-maxOutput); };
    const stop = () => {
      if (!child) return;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      } catch (_) { try { child.kill("SIGKILL"); } catch (_) {} }
    };
    const abort = () => { result.aborted = true; stop(); };
    try {
      child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) { result.error = error; resolve(result); return; }
    child.stdout.on("data", (data) => append("stdout", data));
    child.stderr.on("data", (data) => append("stderr", data));
    child.on("error", (error) => { result.error = error; });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      result.code = code;
      result.signal = exitSignal;
      resolve(result);
    });
    timer = setTimeout(() => { result.timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

module.exports = { runTool };
