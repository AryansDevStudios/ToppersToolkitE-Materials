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
  // Also write to the actual console so you can see output if you're watching it directly
  process.stdout.write(`[${timestamp}] ${message}\n`);
};

// Also redirect any potential errors to the same log file and the console
console.error = function(message) {
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] ERROR: ${message}\n`);
    process.stderr.write(`[${timestamp}] ERROR: ${message}\n`);
};


// Load environment variables from .env file
require('dotenv').config();

// --- Main Application Logic ---

const syncPath = '/workspaces/ToppersToolkitE-Materials'; // The directory to sync

console.log('--- Initializing Git Sync Process ---');
console.log(`Target directory: ${syncPath}`);

// --- Part 1: Pull and Push to GitHub Periodically ---
setInterval(() => {
  console.log('--- Running Git Sync ---');

  const username = process.env.GITHUB_USERNAME;
  const pat = process.env.GITHUB_PAT;

  if (!username || !pat) {
    console.error('GitHub username or PAT not found in .env file.');
    return;
  }

  const remoteUrl = `https://${username}:${pat}@github.com/AryansDevStudios/ToppersToolkitE-Materials.git`;

  if (shell.cd(syncPath).code !== 0) {
    console.error(`Could not change to directory: ${syncPath}`);
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
}, 5000); // Sync interval set to 5 seconds