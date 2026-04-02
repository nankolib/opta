#!/bin/bash
# Syncs the WSL app source to the Windows copy for the dev server.
# Run from WSL: bash ~/projects/butter-options/app/sync.sh
cp -r /home/nanko/projects/butter-options/app/src/* "/mnt/d/claude everything/butter_options_app/src/"
echo "Synced to Windows. Refresh your browser."
