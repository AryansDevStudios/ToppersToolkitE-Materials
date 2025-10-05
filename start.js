const { spawn } = require('child_process');
const shell = require('shelljs');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// --- Part 0: Setup Logging and Environment Variables ---

const projectPath = '/opt/render/project/src/ToppersToolkitE-Materials';
const publicPort = 8080; // The port users will connect to
const filebrowserPort = 8081; // The internal port for File Browser

// Create a write stream for the log file
const logStream = fs.createWriteStream(path.join(__dirname, '.gitlog'), { flags: 'a' });

// Override console.log to write ONLY to the .gitlog file
console.log = function(message) {
  const timestamp = new Date().toISOString();
  logStream.write(`[${timestamp}] ${message}\n`);
};

// Override console.error to write ONLY to the .gitlog file
console.error = function(message) {
  const timestamp = new Date().toISOString();
  logStream.write(`[${timestamp}] ERROR: ${message}\n`);
};

// Load environment variables from .env file
require('dotenv').config();

// --- Main Application Logic ---
process.stdout.write('--- Initializing... All subsequent output will be written to .gitlog ---\n');

// --- Part 1: Start the Backend File Browser Server ---
console.log(`Preparing to start File Browser on internal port ${filebrowserPort}`);
const filebrowserExecutable = path.join(__dirname, 'filebrowser');
// Note: We bind to 127.0.0.1 so it's only accessible internally
const filebrowserArgs = ['-a', '127.0.0.1', '-p', filebrowserPort, '-r', projectPath];

const filebrowser = spawn(filebrowserExecutable, filebrowserArgs);

filebrowser.on('error', (err) => console.error(`Failed to start File Browser: ${err.message}`));
filebrowser.stdout.on('data', (data) => console.log(`[FileBrowser] ${data.toString().trim()}`));
filebrowser.stderr.on('data', (data) => console.error(`[FileBrowser] ${data.toString().trim()}`));
filebrowser.on('close', (code) => console.error(`File Browser process exited with code ${code}`));


// --- Part 2: Create the Main Public-Facing Server (Proxy + Raw Files) ---
const app = express();

// Route 1: Raw File Serving
// Any request to http://<server>/raw/... will serve a file from your project directory.
console.log(`Setting up raw file serving for /raw path`);
app.use('/raw', express.static(projectPath, {
  // Set headers to encourage browser to download rather than display some file types
  setHeaders: (res, filePath) => {
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
  }
}));

// Route 2: Proxy to File Browser
// Any other request will be forwarded to the File Browser UI. This MUST be last.
console.log(`Setting up proxy to forward all other requests to File Browser`);
app.use('/', createProxyMiddleware({
  target: `http://127.0.0.1:${filebrowserPort}`,
  changeOrigin: true,
}));

// Start the main server
app.listen(publicPort, '0.0.0.0', () => {
  console.log(`--- Main server is live on http://0.0.0.0:${publicPort} ---`);
  console.log(`- Requests to /raw will be served directly.`);
  console.log(`- All other requests are proxied to File Browser.`);
});


// --- Part 3: Pull and Push to GitHub Periodically ---
setInterval(() => {
  console.log('--- Running Git Sync ---');

  const username = process.env.GITHUB_USERNAME;
  const pat = process.env.GITHUB_PAT;

  if (!username || !pat) {
    console.error('GitHub username or PAT not found in .env file.');
    return;
  }
  const remoteUrl = `https://${username}:${pat}@github.com/AryansDevStudios/ToppersToolkitE-Materials.git`;

  if (shell.cd(projectPath).code !== 0) {
    console.error(`Could not change to directory: ${projectPath}`);
    return;
  }

  // The rest of the Git sync logic remains exactly the same...
  console.log('Ensuring we are on the main branch...');
  const checkoutResult = shell.exec('git checkout main', { silent: true });
  if (checkoutResult.code !== 0) {
    console.error(`Could not check out main branch. STDERR: ${checkoutResult.stderr}`);
    return;
  }
  let stashedChanges = false;
  if (shell.exec('git status --porcelain', { silent: true }).stdout !== '') {
    console.log('Stashing local changes...');
    shell.exec('git stash', { silent: true });
    stashedChanges = true;
  }
  console.log('Pulling latest changes...');
  const pullResult = shell.exec('git pull --rebase', { silent: true });
  if (pullResult.code !== 0) {
    console.error(`Git pull failed. STDERR: ${pullResult.stderr}`);
    shell.exec('git rebase --abort', { silent: true });
    if (stashedChanges) shell.exec('git stash pop', { silent: true });
    return;
  }
  if (stashedChanges) {
    console.log('Applying stashed changes...');
    const popResult = shell.exec('git stash pop', { silent: true });
    if (popResult.code !== 0) console.error(`Git stash pop failed. STDERR: ${popResult.stderr}`);
  }
  if (shell.exec('git add .', { silent: true }).code !== 0) {
    console.error('Git add failed.');
    return;
  }
  const commitMessage = `Automated commit on ${new Date().toISOString()}`;
  const commitResult = shell.exec(`git commit -m "${commitMessage}"`, { silent: true });
  if (commitResult.code !== 0 && !commitResult.stdout.includes('nothing to commit')) {
    console.error(`Git commit failed. STDERR: ${commitResult.stderr}`);
    return;
  }
  if (commitResult.code === 0) {
    console.log('Pushing changes to remote...');
    const pushResult = shell.exec(`git push ${remoteUrl} HEAD:main`, { silent: true });
    if (pushResult.code !== 0) console.error(`Git push failed. STDERR: ${pushResult.stderr}`);
  } else {
    console.log('No new changes to commit or push.');
  }
  console.log('--- Git Sync Successful ---');
}, 5000);