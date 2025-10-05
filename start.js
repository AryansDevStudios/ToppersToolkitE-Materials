const express = require('express');
const shell = require('shelljs');
const path = require('path');

// --- Part 0: Load Environment Variables ---
// This will load the variables from your .env file into process.env
require('dotenv').config();

const app = express();
const port = 8080;
const servePath = '/opt/render/project/src';

// --- Part 1: Serve Static Files ---
app.use(express.static(servePath));

app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening at http://0.0.0.0:${port}`);
  console.log(`Serving files from ${servePath}`);
});

// --- Part 2: Pull and Push to GitHub Every Second ---
setInterval(() => {
  console.log('--- Running Git Sync ---');

  // Retrieve credentials from environment variables
  const username = process.env.GITHUB_USERNAME;
  const pat = process.env.GITHUB_PAT;

  // Validate that the environment variables are loaded
  if (!username || !pat) {
    console.log('Error: GitHub username or PAT not found in .env file.');
    return;
  }

  // Construct the secure remote URL
  const remoteUrl = `https://${username}:${pat}@github.com/AryansDevStudios/ToppersToolkitE-Materials.git`;

  // Change to the project directory.
  if (shell.cd(servePath).code !== 0) {
    console.log('Error: Could not change to project directory');
    return;
  }

  // Stash any uncommitted changes
  console.log('Stashing local changes...');
  if (shell.exec('git stash').code !== 0) {
    console.log('Error: Git stash failed');
    return;
  }

  // Pull the latest changes from the remote repository with rebase
  console.log('Pulling latest changes...');
  if (shell.exec('git pull --rebase').code !== 0) {
    console.log('Error: Git pull failed. This could be due to a merge conflict.');
    shell.exec('git rebase --abort');
    shell.exec('git stash pop');
    return;
  }

  // Apply the stashed changes
  console.log('Applying stashed changes...');
  if (shell.exec('git stash pop').code !== 0) {
    console.log('Info: No stashed changes to apply.');
  }

  // Add all files to the staging area.
  if (shell.exec('git add .').code !== 0) {
    console.log('Error: Git add failed');
    return;
  }

  // Commit the changes with a timestamp.
  const commitMessage = `Automated commit on ${new Date().toISOString()}`;
  const commitResult = shell.exec(`git commit -m "${commitMessage}"`);
  if (commitResult.code !== 0 && !commitResult.stdout.includes('nothing to commit')) {
    console.log('Error: Git commit failed.');
    return;
  }

  // Push the changes to the remote repository using the secure URL.
  if (shell.exec(`git push ${remoteUrl} HEAD:main`).code !== 0) {
    console.log('Error: Git push failed');
    return;
  }

  console.log('--- Git Sync Successful ---');
}, 1000); // The interval is set to 1000 milliseconds (1 second).