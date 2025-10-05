const { spawn } = require('child_process');
const shell = require('shelljs');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// --- Part 0: Setup Logging and Environment Variables ---

const projectPath = '/opt/render/project/src/';
const publicPort = 8080;
const filebrowserPort = 8081;

// Create a write stream for the log file
const logStream = fs.createWriteStream(path.join(__dirname, '.gitlog'), { flags: 'a' });

// Override console.log and console.error to write ONLY to the .gitlog file
console.log = (message) => logStream.write(`[${new Date().toISOString()}] ${message}\n`);
console.error = (message) => logStream.write(`[${new Date().toISOString()}] ERROR: ${message}\n`);

// Load environment variables
require('dotenv').config();

// --- Main Application Logic ---
process.stdout.write('--- Initializing... All subsequent output will be written to .gitlog ---\n');

// --- Part 1: Start the Backend File Browser Server ---
console.log(`Preparing to start File Browser on internal port ${filebrowserPort}`);
const filebrowserExecutable = path.join(__dirname, 'filebrowser');
const filebrowserArgs = ['-a', '127.0.0.1', '-p', filebrowserPort, '-r', projectPath];
const filebrowser = spawn(filebrowserExecutable, filebrowserArgs);

filebrowser.on('error', (err) => console.error(`Failed to start File Browser: ${err.message}`));
filebrowser.stdout.on('data', (data) => console.log(`[FileBrowser] ${data.toString().trim()}`));
filebrowser.stderr.on('data', (data) => console.error(`[FileBrowser] ${data.toString().trim()}`));
filebrowser.on('close', (code) => console.error(`File Browser process exited with code ${code}`));

// --- Part 2: Create the Main Public-Facing Server (Proxy + Raw Files) ---
const app = express();
console.log(`Setting up raw file serving for /raw path`);
app.use('/raw', express.static(projectPath));
console.log(`Setting up proxy to forward all other requests to File Browser`);
app.use('/', createProxyMiddleware({ target: `http://127.0.0.1:${filebrowserPort}`, changeOrigin: true }));
app.listen(publicPort, '0.0.0.0', () => {
  console.log(`--- Main server is live on http://0.0.0.0:${publicPort} ---`);
  console.log(`- Requests to /raw will be served directly.`);
  console.log(`- All other requests are proxied to File Browser.`);
});

// --- Part 3: One-Time Git Initialization ---
const username = process.env.GITHUB_USERNAME;
const pat = process.env.GITHUB_PAT;
const remoteUrl = `https://${username}:${pat}@github.com/AryansDevStudios/ToppersToolkitE-Materials.git`;

// Change to the project directory for all Git operations
shell.cd(projectPath);

if (!fs.existsSync(path.join(projectPath, '.git'))) {
  console.log('No .git directory found. Initializing new repository...');
  if (shell.exec('git init').code !== 0) {
    console.error('Failed to initialize Git repository.');
  } else if (shell.exec(`git remote add origin "${remoteUrl}"`).code !== 0) {
    console.error('Failed to add remote origin.');
  } else if (shell.exec('git fetch origin').code !== 0) {
    console.error('Failed to fetch from remote origin.');
  } else if (shell.exec('git checkout -t origin/main').code !== 0) {
    console.error('Failed to checkout main branch. It might not exist on the remote yet.');
    // Fallback if main doesn't exist remotely
    shell.exec('git checkout -b main');
  } else {
    console.log('Git repository initialized and connected to remote successfully.');
  }
} else {
    console.log('.git directory found. Skipping initialization.');
}


// --- Part 4: Pull and Push to GitHub Periodically ---
setInterval(() => {
  console.log('--- Running Git Sync ---');
  if (!username || !pat) {
    console.error('GitHub username or PAT not found in .env file.');
    return;
  }

  // The rest of the Git sync logic remains the same...
  console.log('Ensuring we are on the main branch...');
  if (shell.exec('git checkout main', { silent: true }).code !== 0) {
    console.error(`Could not check out main branch.`);
    return;
  }
  let stashedChanges = false;
  if (shell.exec('git status --porcelain', { silent: true }).stdout !== '') {
    console.log('Stashing local changes...');
    shell.exec('git stash', { silent: true });
    stashedChanges = true;
  }
  console.log('Pulling latest changes...');
  if (shell.exec('git pull --rebase', { silent: true }).code !== 0) {
    console.error(`Git pull failed.`);
    shell.exec('git rebase --abort', { silent: true });
    if (stashedChanges) shell.exec('git stash pop', { silent: true });
    return;
  }
  if (stashedChanges) {
    console.log('Applying stashed changes...');
    if (shell.exec('git stash pop', { silent: true }).code !== 0) {
        console.error(`Git stash pop failed.`);
    }
  }
  if (shell.exec('git add .', { silent: true }).code !== 0) {
    console.error('Git add failed.');
    return;
  }
  const commitMessage = `Automated commit on ${new Date().toISOString()}`;
  const commitResult = shell.exec(`git commit -m "${commitMessage}"`, { silent: true });
  if (commitResult.code !== 0 && !commitResult.stdout.includes('nothing to commit')) {
    console.error(`Git commit failed.`);
    return;
  }
  if (commitResult.code === 0) {
    console.log('Pushing changes to remote...');
    if (shell.exec(`git push ${remoteUrl} HEAD:main`, { silent: true }).code !== 0) {
        console.error(`Git push failed.`);
    }
  } else {
    console.log('No new changes to commit or push.');
  }
  console.log('--- Git Sync Successful ---');
}, 5000);