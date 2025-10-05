#!/bin/bash

# Navigate to your git repository
# IMPORTANT: Replace "/path/to/your/repo" with the actual path to your local repository
cd "/opt/render/project/src"

# Pull the latest changes from the remote repository
git pull origin main

# Check for changes
if ! git diff-index --quiet HEAD --; then
    echo "Changes detected. Committing and pushing..."

    # Add all new and modified files
    git add .

    # Commit the changes with a timestamped message
    git commit -m "Automated commit: $(date)"

    # Push the changes
    git push origin main
else
    echo "No changes to commit."
fi
