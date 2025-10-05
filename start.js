const { spawn } = require('child_process');
const shell = require('shelljs');
const path = require('path');
const fs = require('fs');

// --- Part 0: Setup Logging and Environment Variables ---

const projectPath = '/workspaces/ToppersToolkitE-Materials';
const logStream = fs.createWriteStream(path.join(__dirname, '.gitlog'), { flags: 'a' });

console.log = function(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  logStream.write(logMessage);
  process.stdout.write(logMessage);
};

console.error = function(message) {
  const timestamp = new Date().toISOString();
  const errorMessage = `[${timestamp}] ERROR: ${message}\n`;
  logStream.write(errorMessage);
  process.stderr.write(errorMessage);
};

require('dotenv').config();

// --- Main Application Logic ---

console.log('--- Initializing File Browser and Git Sync Process ---');

// --- Part 1: Start the File Browser Server ---

// --- FIX: Define the full path to the filebrowser executable ---
const filebrowserExecutable = path.join(__dirname, 'filebrowser');

const filebrowserArgs = ['-a', '0.0.0.0', '-p', '8080', '-r', projectPath];

console.log(`Starting File Browser on 0.0.0.0:8080 for directory ${projectPath}`);
// --- FIX: Use the full path in the spawn command ---
const filebrowser = spawn(filebrowserExecutable, filebrowserArgs);

// --- FIX: Add a specific error handler for the spawn process itself ---
// This will catch the 'ENOENT' error and prevent the script from crashing.
filebrowser.on('error', (err) => {
  console.error(`Failed to start File Browser process: ${err.message}`);
  console.error('Please ensure the "filebrowser" executable is in the same directory as this script and has execute permissions (chmod +x filebrowser).');
});

filebrowser.stdout.on('data', (data) => {
  console.log(`[FileBrowser] ${data.toString().trim()}`);
});

filebrowser.stderr.on('data', (data) => {
  console.error(`[FileBrowser] ${data.toString().trim()}`);
});

filebrowser.on('close', (code) => {
  console.error(`File Browser process exited with code ${code}`);
});

// --- Part 2: Pull and Push to GitHub Periodically (No changes below this line) ---
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

  console.log('Ensuring we are on the main branch...');
  const checkoutResult = shell.exec('git checkout main', { silent: true });
  if (checkoutResult.code !== 0) {
    console.error('Could not check out main branch.');
    console.error(`- STDERR: ${checkoutResult.stderr}`);
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
    console.error('Git pull failed. This could be due to a merge conflict.');
    console.error(`- STDERR: ${pullResult.stderr}`);
    shell.exec('git rebase --abort', { silent: true });
    if (stashedChanges) {
      shell.exec('git stash pop', { silent: true });
    }
    return;
  }

  if (stashedChanges) {
    console.log('Applying stashed changes...');
    const stashPopResult = shell.exec('git stash pop', { silent: true });
    if (stashPopResult.code !== 0) {
       console.error('Git stash pop failed, likely due to conflicts.');
       console.error(`- STDERR: ${stashPopResult.stderr}`);
    }
  }

  const addResult = shell.exec('git add .', { silent: true });
  if (addResult.code !== 0) {
    console.error('Git add failed.');
    console.error(`- STDERR: ${addResult.stderr}`);
    return;
  }

  const commitMessage = `Automated commit on ${new Date().toISOString()}`;
  const commitResult = shell.exec(`git commit -m "${commitMessage}"`, { silent: true });
  if (commitResult.code !== 0 && !commitResult.stdout.includes('nothing to commit')) {
    console.error('Git commit failed.');
    console.error(`- STDERR: ${commitResult.stderr}`);
    return;
  }

  if (commitResult.code === 0) {
    console.log('Pushing changes to remote...');
    const pushResult = shell.exec(`git push ${remoteUrl} HEAD:main`, { silent: true });
    if (pushResult.code !== 0) {
      console.error('Git push failed');
      console.error(`- STDERR: ${pushResult.stderr}`);
      return;
    }
  } else {
    console.log('No new changes to commit or push.');
  }

  console.log('--- Git Sync Successful ---');
}, 5000);