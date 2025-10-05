// server.js
// SSE + HTTP POST based web terminal (no WebSocket)
// Auto-restarts PTY if it exits.

const express = require("express");
const pty = require("node-pty");
const path = require("path");
const bodyParser = require("body-parser");
const helmet = require("helmet");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT || 3000;

const app = express();

// Helmet (disable CSP for local testing)
app.use(helmet({ contentSecurityPolicy: false }));

app.use(bodyParser.text({ type: "*/*", limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Serve xterm.js and xterm.css locally
app.use("/xterm.js", express.static(path.join(__dirname, "node_modules/xterm/lib/xterm.js")));
app.use("/xterm.css", express.static(path.join(__dirname, "node_modules/xterm/css/xterm.css")));

// SSE clients
let sseClients = new Set();

// PTY management
let ptyProcess = null;

function createPty() {
  const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");

  const p = pty.spawn(shell, [], {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: process.env,
  });

  // Broadcast PTY output to all SSE clients
  p.on("data", (data) => {
    for (const res of sseClients) {
      try {
        const safe = data.replace(/\r/g, "");
        res.write(`data: ${JSON.stringify(safe)}\n\n`);
      } catch {}
    }
  });

  // Auto-restart if PTY exits
  p.on("exit", (code, signal) => {
    console.log(`PTY exited (code=${code}, signal=${signal}) — restarting...`);
    ptyProcess = createPty();
  });

  return p;
}

// Create the first PTY
ptyProcess = createPty();

// SSE endpoint
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const hb = setInterval(() => res.write(":hb\n\n"), 25000);
  sseClients.add(res);

  req.on("close", () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
});

// Receive user input
app.post("/input", (req, res) => {
  const chunk = req.body || "";
  if (ptyProcess) ptyProcess.write(chunk);
  res.status(204).end();
});

// Resize terminal
app.post("/resize", (req, res) => {
  try {
    const parsed = typeof req.body === "string" && req.body.length ? JSON.parse(req.body) : {};
    const cols = parseInt(parsed.cols, 10) || 80;
    const rows = parseInt(parsed.rows, 10) || 24;
    if (ptyProcess) ptyProcess.resize(cols, rows);
    res.status(204).end();
  } catch {
    res.status(400).send("bad resize payload");
  }
});

// Health check
app.get("/ping", (req, res) => res.send("ok"));

// Start server
app.listen(PORT, HOST, () => {
  console.log(`✅ SSE terminal server listening on http://${HOST}:${PORT}`);
  console.log(`👉 Open http://${HOST}:${PORT}/ in a browser.`);
});
