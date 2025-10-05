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
const logMessage = (message) => logStream.write(`[${new Date().toISOString()}] ${message}\n`);
console.log = logMessage;
console.error = (message) => logMessage(`ERROR: ${message}`);

require('dotenv').config();
process.stdout.write('--- Initializing... All subsequent output will be written to .gitlog ---\n');

// --- Part 1: Start Core Backend Services (File Browser + PTY) ---
console.log(`Starting File Browser on internal port ${filebrowserPort}`);
const filebrowserExecutable = path.join(__dirname, 'filebrowser');
const filebrowser = spawn(filebrowserExecutable, ['-a', '127.0.0.1', '-p', filebrowserPort, '-r', projectPath]);
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
  p.on("data", (data) => {
    for (const res of sseClients) {
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e) {
        console.error(`Error writing to SSE client: ${e.message}`);
      }
    }
  });
  p.on("exit", (code) => {
    console.log(`PTY exited (code=${code}) — restarting...`);
    ptyProcess = createPty();
  });
  return p;
}
ptyProcess = createPty();

// --- Part 2: Create and Configure the Public-Facing Server ---
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));

// Route for Raw File Access
app.use('/raw', express.static(projectPath));

// Setup Terminal Routes
const terminalRouter = express.Router();
terminalRouter.use(bodyParser.text({ type: "*/*" }));
terminalRouter.use(express.static(path.join(__dirname, "public")));
terminalRouter.use("/xterm.js", express.static(path.join(__dirname, "node_modules/xterm/lib/xterm.js")));
terminalRouter.use("/xterm.css", express.static(path.join(__dirname, "node_modules/xterm/css/xterm.css")));
terminalRouter.get("/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(":hb\n\n"), 25000);
  sseClients.add(res);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});
terminalRouter.post("/input", (req, res) => {
  if (ptyProcess) ptyProcess.write(req.body || "");
  res.status(204).end();
});
terminalRouter.post("/resize", (req, res) => {
  try {
    const { cols, rows } = JSON.parse(req.body);
    if (ptyProcess) ptyProcess.resize(cols, rows);
    res.status(204).end();
  } catch {
    res.status(400).end();
  }
});
app.use('/terminal', terminalRouter);

// Default Route Proxies to File Manager
app.use('/', createProxyMiddleware({
  target: `http://127.0.0.1:${filebrowserPort}`,
  changeOrigin: true,
  ws: true // Enable WebSocket proxying for File Browser features
}));

/**
 * Initializes the Git repository, fetches the remote, and sets up periodic tasks.
 * This function is designed to be called only *after* the main server is confirmed to be live.
 */
function setupGitAndPeriodicTasks() {
    console.log('--- Server is public, now setting up Git repository ---');

    // Part 3: Force Fresh Git Initialization
    const username = process.env.GITHUB_USERNAME;
    const pat = process.env.GITHUB_PAT;
    const gitName = process.env.GIT_USER_NAME;
    const gitEmail = process.env.GIT_USER_EMAIL;

    if (!username || !pat || !gitName || !gitEmail) {
        console.error('CRITICAL: Required GitHub or Git environment variables are missing.');
        return; // Stop if configuration is incomplete
    }

    const remoteUrl = `https://${username}:${pat}@github.com/AryansDevStudios/ToppersToolkitE-Materials.git`;
    shell.cd(projectPath);

    console.log('Removing old .git directory if it exists...');
    shell.rm('-rf', path.join(projectPath, '.git'));

    console.log('Initializing new Git repository and configuring user identity...');
    shell.exec('git init');
    shell.exec('git config --global init.defaultBranch main');
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

      if (shell.exec('git checkout main', { silent: true }).code !== 0) {
        console.error(`Could not check out main branch.`);
        return;
      }
      const hasLocalChanges = shell.exec('git status --porcelain', { silent: true }).stdout !== '';
      if (hasLocalChanges) {
          console.log('Stashing local changes...');
          shell.exec('git stash', { silent: true });
      }

      if (shell.exec('git pull --rebase', { silent: true }).code !== 0) {
        console.error(`Git pull failed. Aborting rebase.`);
        shell.exec('git rebase --abort', { silent: true });
        if (hasLocalChanges) shell.exec('git stash pop', { silent: true });
        return;
      }
      if (hasLocalChanges) {
          if (shell.exec('git stash pop', { silent: true }).code !== 0) {
            console.error(`Git stash pop failed. Local changes may be lost.`);
          }
      }

      if (shell.exec('git add .', { silent: true }).code !== 0) {
        console.error('Git add failed.');
        return;
      }

      const commitResult = shell.exec(`git commit -m "Automated commit on ${new Date().toISOString()}"`, { silent: true });
      if (commitResult.code === 0) {
          console.log('Pushing changes to remote...');
          if (shell.exec(`git push ${remoteUrl} HEAD:main`, { silent: true }).code !== 0) {
            console.error(`Git push failed.`);
          }
      } else if (!commitResult.stdout.includes('nothing to commit')) {
          console.error(`Git commit failed.`);
          return;
      } else {
          console.log('No new changes to commit.');
      }
      console.log('--- Git Sync Finished ---');
    }, 300000); // Sync every 5 minutes (300,000 ms)

    // Part 5: Keep-Alive Service
    setInterval(() => {
      console.log(`Sending keep-alive ping to ${keepAliveUrl}`);
      https.get(keepAliveUrl, (res) => {
        console.log(`Keep-alive ping status: ${res.statusCode}`);
      }).on('error', (err) => {
        console.error(`Keep-alive ping error: ${err.message}`);
      });
    }, 600000); // Ping every 10 minutes (600,000 ms)
}


// --- SERVER START & POST-START LOGIC ---
app.listen(publicPort, '0.0.0.0', () => {
    console.log(`--- File Manager, Terminal, and Raw Server are live on http://0.0.0.0:${publicPort} ---`);
    
    // Defer the heavy Git operations until after the server has started successfully.
    setupGitAndPeriodicTasks();
});