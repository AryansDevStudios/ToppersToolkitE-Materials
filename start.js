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
const publicPort = process.env.PORT || 8080; // Use Render's port variable
const filebrowserPort = 8081;
const keepAliveUrl = 'https://topperstoolkite-materials.onrender.com/';
const dbPath = path.join(__dirname, 'filebrowser.db');

const logStream = fs.createWriteStream(path.join(__dirname, '.gitlog'), { flags: 'a' });
const logMessage = (message) => logStream.write(`[${new Date().toISOString()}] ${message}\n`);
console.log = logMessage;
console.error = (message) => logMessage(`ERROR: ${message}`);

require('dotenv').config();
process.stdout.write('--- Initializing... All subsequent output will be written to .gitlog ---\n');

// --- Part 1: Start FAST Backend Services (File Browser + PTY) ---
// This part is fast and non-blocking, so it's safe to run before the server starts.

console.log('Setting File Browser admin password from .env...');
const adminPassword = process.env.FILEBROWSER_PASSWORD;
if (adminPassword) {
    shell.exec(`./filebrowser users update admin --password "${adminPassword}" --db ${dbPath}`, { silent: true });
    console.log('File Browser password command executed.');
}

console.log(`Starting File Browser on internal port ${filebrowserPort}`);
const filebrowserExecutable = path.join(__dirname, 'filebrowser');
const filebrowser = spawn(filebrowserExecutable, ['-a', '127.0.0.1', '-p', filebrowserPort, '-r', projectPath, `--database=${dbPath}`]);
filebrowser.on('error', (err) => console.error(`Failed to start File Browser: ${err.message}`));
filebrowser.stdout.on('data', (data) => console.log(`[FileBrowser] ${data.toString().trim()}`));
filebrowser.stderr.on('data', (data) => console.error(`[FileBrowser] ${data.toString().trim()}`));
filebrowser.on('close', (code) => console.error(`File Browser process exited with code ${code}`));

console.log('Initializing web terminal PTY process...');
let ptyProcess = null;
const sseClients = new Set();
function createPty() {
  const termShell = process.env.SHELL || 'bash';
  const p = pty.spawn(termShell, ['--login'], { name: "xterm-color", cols: 80, rows: 24, cwd: projectPath, env: process.env });
  p.on("data", (data) => { for (const res of sseClients) { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} } });
  p.on("exit", (code) => { console.log(`PTY exited (code=${code}) — restarting...`); ptyProcess = createPty(); });
  return p;
}
ptyProcess = createPty();

// --- Part 2: Create the Main Public-Facing Server and Define Routes ---
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use('/raw', express.static(projectPath));
const terminalRouter = express.Router();
terminalRouter.use(bodyParser.text({ type: "*/*" }));
terminalRouter.use(express.static(path.join(__dirname, "public")));
terminalRouter.use("/xterm.js", express.static(path.join(__dirname, "node_modules/xterm/lib/xterm.js")));
terminalRouter.use("/xterm.css", express.static(path.join(__dirname, "node_modules/xterm/css/xterm.css")));
terminalRouter.get("/events", (req, res) => { res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" }); res.flushHeaders(); const hb = setInterval(() => res.write(":hb\n\n"), 25000); sseClients.add(res); req.on("close", () => { clearInterval(hb); sseClients.delete(res); }); });
terminalRouter.post("/input", (req, res) => { if (ptyProcess) ptyProcess.write(req.body || ""); res.status(204).end(); });
terminalRouter.post("/resize", (req, res) => { try { const { cols, rows } = JSON.parse(req.body); if (ptyProcess) ptyProcess.resize(cols, rows); res.status(204).end(); } catch { res.status(400).end(); }});
app.use('/terminal', terminalRouter);
app.use('/', createProxyMiddleware({ target: `http://127.0.0.1:${filebrowserPort}`, changeOrigin: true, ws: true }));


/**
 * SLOW, BLOCKING TASKS: Initializes Git and sets up periodic sync.
 * This function should ONLY be called AFTER the main server is confirmed to be live.
 */
function setupGitAndPeriodicTasks() {
    console.log('--- Server is public, now setting up Git repository ---');

    const username = process.env.GITHUB_USERNAME;
    const pat = process.env.GITHUB_PAT;
    const gitName = process.env.GIT_USER_NAME;
    const gitEmail = process.env.GIT_USER_EMAIL;

    if (!username || !pat || !gitName || !gitEmail) {
        console.error('CRITICAL: Required GitHub or Git environment variables are missing. Skipping Git setup.');
        return;
    }

    const remoteUrl = `https://${username}:${pat}@github.com/AryansDevStudios/ToppersToolkitE-Materials.git`;
    shell.cd(projectPath);

    console.log('Removing old .git directory if it exists...');
    shell.rm('-rf', path.join(projectPath, '.git'));

    console.log('Initializing new Git repository and configuring user identity...');
    shell.exec('git config --global init.defaultBranch main');
    shell.exec('git init');
    shell.exec(`git config --global user.name "${gitName}"`);
    shell.exec(`git config --global user.email "${gitEmail}"`);

    console.log('Adding remote origin, fetching, and checking out main branch...');
    shell.exec(`git remote add origin "${remoteUrl}"`);
    shell.exec('git fetch origin');
    if (shell.exec('git checkout -t origin/main').code !== 0) {
        console.error('Could not check out remote "main" branch. Creating a local one.');
        shell.exec('git checkout -b main');
    }
    console.log('--- Git repository successfully re-initialized ---');

    // Part 4: Periodic Git Sync
    setInterval(() => {
      console.log('--- Running Git Sync ---');
      shell.cd(projectPath);
      // [Sync logic remains the same]
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
    }, 300000);

    // Part 5: Keep-Alive Service
    setInterval(() => {
      console.log(`Sending keep-alive ping to ${keepAliveUrl}`);
      https.get(keepAliveUrl, (res) => { console.log(`Keep-alive ping status: ${res.statusCode}`); }).on('error', (err) => { console.error(`Keep-alive ping error: ${err.message}`); });
    }, 600000);
}


// --- SERVER START & POST-START LOGIC ---
app.listen(publicPort, '0.0.0.0', () => {
    // THIS IS THE MOST IMPORTANT PART:
    // The server is now live and listening on the public port.
    // Render's health check will pass immediately.
    console.log(`--- Main server is live on http://0.0.0.0:${publicPort} ---`);
    console.log('Server started. Deferring heavy Git initialization to run in the background.');

    // Now, AFTER the server is live, we call the slow function.
    // We use a small timeout to ensure the event loop is clear to respond to Render.
    setTimeout(() => {
        setupGitAndPeriodicTasks();
    }, 100);
});