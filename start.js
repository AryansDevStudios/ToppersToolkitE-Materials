// --- All Required Imports ---
const { spawn } = require('child_process');
const https = require('https');
const shell = require('shelljs');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const pty = require("node-pty");
const bodyParser = require("body-parser");
const helmet = require("helmet");

// --- Part 0: Setup Logging and Environment Variables ---
const projectPath = '/opt/render/project/src/';
const publicPort = 8080;
const filebrowserPort = 8081;
const keepAliveUrl = 'https://topperstoolkite-materials.onrender.com/';

const logStream = fs.createWriteStream(path.join(__dirname, '.gitlog'), { flags: 'a' });
console.log = (message) => logStream.write(`[${new Date().toISOString()}] ${message}\n`);
console.error = (message) => logStream.write(`[${new Date().toISOString()}] ERROR: ${message}\n`);

require('dotenv').config();
process.stdout.write('--- Initializing... All subsequent output will be written to .gitlog ---\n');

// --- Part 1: Start Backend Services (File Browser + PTY) ---

// 1A: Start File Browser on its internal port
console.log(`Starting File Browser on internal port ${filebrowserPort}`);
const filebrowserExecutable = path.join(__dirname, 'filebrowser');
const filebrowserArgs = ['-a', '127.0.0.1', '-p', filebrowserPort, '-r', projectPath];
const filebrowser = spawn(filebrowserExecutable, filebrowserArgs);
filebrowser.on('error', (err) => console.error(`Failed to start File Browser: ${err.message}`));
filebrowser.stdout.on('data', (data) => console.log(`[FileBrowser] ${data.toString().trim()}`));
filebrowser.stderr.on('data', (data) => console.error(`[FileBrowser] ${data.toString().trim()}`));
filebrowser.on('close', (code) => console.error(`File Browser process exited with code ${code}`));

// 1B: Setup the Web Terminal PTY Process
console.log('Initializing web terminal PTY process...');
let ptyProcess = null;
let sseClients = new Set();
function createPty() {
  const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");
  const p = pty.spawn(shell, [], { name: "xterm-color", cols: 80, rows: 24, cwd: projectPath, env: process.env });
  p.on("data", (data) => { for (const res of sseClients) { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} } });
  p.on("exit", (code) => { console.log(`PTY exited (code=${code}) — restarting...`); ptyProcess = createPty(); });
  return p;
}
ptyProcess = createPty();

// --- Part 2: Create the Main Public-Facing Server and Define Routes ---
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));

// The Order of Routes is CRITICAL
// 1. Raw File Serving
app.use('/raw', express.static(projectPath));

// 2. Web Terminal on /terminal
const terminalRouter = express.Router();
terminalRouter.use(bodyParser.text({ type: "*/*" }));
terminalRouter.use(express.static(path.join(__dirname, "public")));
terminalRouter.use("/xterm.js", express.static(path.join(__dirname, "node_modules/xterm/lib/xterm.js")));
terminalRouter.use("/xterm.css", express.static(path.join(__dirname, "node_modules/xterm/css/xterm.css")));
terminalRouter.get("/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const hb = setInterval(() => res.write(":hb\n\n"), 25000);
  sseClients.add(res);
  req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
});
terminalRouter.post("/input", (req, res) => { if (ptyProcess) ptyProcess.write(req.body || ""); res.status(204).end(); });
terminalRouter.post("/resize", (req, res) => { try { const { cols, rows } = JSON.parse(req.body); if (ptyProcess) ptyProcess.resize(cols, rows); res.status(204).end(); } catch { res.status(400).end(); }});
app.use('/terminal', terminalRouter);

// 3. Proxy to File Browser (Catch-All - MUST BE LAST)
app.use('/', createProxyMiddleware({ target: `http://127.0.0.1:${filebrowserPort}`, changeOrigin: true }));

// Start the main server
app.listen(publicPort, '0.0.0.0', () => {
  console.log(`--- Main server live on http://0.0.0.0:${publicPort} ---`);
  console.log(`- File Browser UI is at /`);
  console.log(`- Web Terminal is at /terminal`);
  console.log(`- Raw file access is at /raw`);
});

// --- Part 3: One-Time Git Initialization ---
const username = process.env.GITHUB_USERNAME;
const pat = process.env.GITHUB_PAT;
const remoteUrl = `https://${username}:${pat}@github.com/AryansDevStudios/ToppersToolkitE-Materials.git`;
shell.cd(projectPath);
if (!fs.existsSync(path.join(projectPath, '.git'))) {
  console.log('No .git directory found. Initializing new repository...');
  shell.exec('git init');
  shell.exec(`git remote add origin "${remoteUrl}"`);
  shell.exec('git fetch origin');
  if (shell.exec('git checkout -t origin/main').code !== 0) {
      console.error('Failed to checkout remote main branch, creating local main.');
      shell.exec('git checkout -b main');
  }
} else {
  console.log('.git directory found. Skipping initialization.');
}

// --- Part 4: Periodic Git Sync ---
setInterval(() => {
  console.log('--- Running Git Sync ---');
  if (!username || !pat) { console.error('GitHub credentials not found.'); return; }
  shell.cd(projectPath);
  if (shell.exec('git checkout main', { silent: true }).code !== 0) { console.error(`Could not check out main branch.`); return; }
  let stashedChanges = false;
  if (shell.exec('git status --porcelain', { silent: true }).stdout !== '') { console.log('Stashing local changes...'); shell.exec('git stash', { silent: true }); stashedChanges = true; }
  if (shell.exec('git pull --rebase', { silent: true }).code !== 0) { console.error(`Git pull failed.`); shell.exec('git rebase --abort', { silent: true }); if (stashedChanges) shell.exec('git stash pop', { silent: true }); return; }
  if (stashedChanges) { if (shell.exec('git stash pop', { silent: true }).code !== 0) { console.error(`Git stash pop failed.`); } }
  if (shell.exec('git add .', { silent: true }).code !== 0) { console.error('Git add failed.'); return; }
  const commitResult = shell.exec(`git commit -m "Automated commit on ${new Date().toISOString()}"`, { silent: true });
  if (commitResult.code !== 0 && !commitResult.stdout.includes('nothing to commit')) { console.error(`Git commit failed.`); return; }
  if (commitResult.code === 0) { console.log('Pushing changes to remote...'); if (shell.exec(`git push ${remoteUrl} HEAD:main`, { silent: true }).code !== 0) { console.error(`Git push failed.`); } }
  else { console.log('No new changes to commit or push.'); }
  console.log('--- Git Sync Successful ---');
}, 5000);

// --- Part 5: Keep-Alive Service ---
setInterval(() => {
  console.log(`Sending keep-alive ping to ${keepAliveUrl}`);
  https.get(keepAliveUrl, (res) => {
    if (res.statusCode >= 200 && res.statusCode < 400) {
      console.log(`Keep-alive ping successful (Status: ${res.statusCode}).`);
    } else {
      console.error(`Keep-alive ping failed (Status: ${res.statusCode}).`);
    }
  }).on('error', (err) => {
    console.error(`Keep-alive ping error: ${err.message}`);
  });
}, 10000); // 10 seconds