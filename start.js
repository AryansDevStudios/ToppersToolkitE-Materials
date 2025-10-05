const express = require('express');
const shell = require('shelljs');
const path = require('path');
const fs = require('fs');

// --- Part 0: Setup Logging and Environment Variables ---

// Create a write stream for the log file. The 'a' flag means we will append to the file.
const logStream = fs.createWriteStream(path.join(__dirname, '.gitlog'), { flags: 'a' });

// Override the default console.log to write to our file instead
console.log = function(message) {
  const timestamp = new Date().toISOString();
  // Write the timestamped message to the log file, followed by a newline
  logStream.write(`[${timestamp}] ${message}\n`);
};

// Also redirect any potential errors to the same log file
console.error = console.log;

// Load environment variables from .env file
require('dotenv').config();

// --- Main Application Logic ---

const app = express();
const port = 8080;
const servePath = '/workspaces/ToppersToolkitE-Materials';

console.log('--- Initializing Server and Git Sync Process ---');

// --- Part 1: Serve Static Files ---
app.use(express.static(servePath));

app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening at http://0.0.0.0:${port}`);
  console.log(`Serving files from ${servePath}`);
});

// --- Part 2: Pull and Push to GitHub Every Second ---
setInterval(() => {
  console.log('--- Running Git Sync ---');

  const username = process.env.GITHUB_USERNAME;
  const pat = process.env.GITHUB_PAT;

  if (!username || !pat) {
    console.log('Error: GitHub username or PAT not found in .env file.');
    return;
  }

  const remoteUrl = `https://${username}:${pat}@github.com/AryansDevStudios/ToppersToolkitE-Materials.git`;

  if (shell.cd(servePath).code !== 0) {
    console.log('Error: Could not change to project directory');
    return;
  }

  console.log('Ensuring we are on the main branch...');
  const checkoutResult = shell.exec('git checkout main', { silent: true });
  if (checkoutResult.code !== 0) {
    console.log('Error: Could not check out main branch.');
    console.log(`- STDERR: ${checkoutResult.stderr}`);
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
    console.log('Error: Git pull failed. This could be due to a merge conflict.');
    console.log(`- STDERR: ${pullResult.stderr}`);
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
       console.log('Warning: Git stash pop failed, likely due to conflicts.');
       console.log(`- STDERR: ${stashPopResult.stderr}`);
    }
  }

  const addResult = shell.exec('git add .', { silent: true });
  if (addResult.code !== 0) {
    console.log('Error: Git add failed.');
    console.log(`- STDERR: ${addResult.stderr}`);
    return;
  }

  const commitMessage = `Automated commit on ${new Date().toISOString()}`;
  const commitResult = shell.exec(`git commit -m "${commitMessage}"`, { silent: true });
  if (commitResult.code !== 0 && !commitResult.stdout.includes('nothing to commit')) {
    console.log('Error: Git commit failed.');
    console.log(`- STDERR: ${commitResult.stderr}`);
    return;
  }

  // Only attempt to push if there was something to commit
  if (commitResult.code === 0) {
    console.log('Pushing changes to remote...');
    const pushResult = shell.exec(`git push ${remoteUrl} HEAD:main`, { silent: true });
    if (pushResult.code !== 0) {
      console.log('Error: Git push failed');
      console.log(`- STDERR: ${pushResult.stderr}`);
      return;
    }
  } else {
    console.log('No new changes to commit or push.');
  }

  console.log('--- Git Sync Successful ---');
}, 5000);