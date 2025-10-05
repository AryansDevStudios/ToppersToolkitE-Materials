const express = require('express');
const shell = require('shelljs');
const path = require('path');

const app = express();
const port = 8080;
const servePath = '/opt/render/project/src';

// --- Part 1: Serve Static Files ---
// This sets up an Express server to serve files from the 'servePath' directory.
app.use(express.static(servePath));

app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening at http://0.0.0.0:${port}`);
  console.log(`Serving files from ${servePath}`);
});

// --- Part 2: Push to GitHub Every Second ---
// This interval function will run the Git commands every 1000 milliseconds (1 second).
setInterval(() => {
  console.log('--- Running Git Push ---');

  // Change to the directory of your project.
  // shell.cd() returns an object, and its 'code' property will be 0 on success.
  if (shell.cd(servePath).code !== 0) {
    console.log('Error: Could not change to project directory');
    return; // Exit the function if changing directory fails.
  }

  // Add all files in the current directory to the Git staging area.
  // shell.exec() also returns an object with a 'code' property for the exit code.
  if (shell.exec('git add .').code !== 0) {
    console.log('Error: Git add failed');
    return;
  }

  // Commit the changes with a message that includes the current timestamp.
  const commitMessage = `Automated commit on ${new Date().toISOString()}`;
  if (shell.exec(`git commit -m "${commitMessage}"`).code !== 0) {
    // This part might log an error if there are no changes to commit.
    // Git's commit command exits with a non-zero status in that case.
    console.log('Error: Git commit failed. This may be because there are no changes to commit.');
    return;
  }

  // Push the committed changes to the remote repository.
  if (shell.exec('git push').code !== 0) {
    console.log('Error: Git push failed');
    return;
  }

  console.log('--- Git Push Successful ---');
}, 1000); // The interval is set to 1000 milliseconds (1 second).