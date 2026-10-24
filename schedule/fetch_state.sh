#!/usr/bin/env bash
# Checks out the run state repo as .state.git (work tree: this folder) on a
# GitHub Actions runner, with STATE_DEPLOY_KEY as the SSH key. Used by both
# workflows; schedule/run_job.py explains the state repo.
set -euo pipefail
mkdir -p ~/.ssh
printf '%s\n' "$STATE_DEPLOY_KEY" > ~/.ssh/state_key
chmod 600 ~/.ssh/state_key
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
git config --global core.sshCommand "ssh -i ~/.ssh/state_key -o IdentitiesOnly=yes"
git config --global user.name "threat-monitor (GitHub Actions)"
git config --global user.email "actions@users.noreply.github.com"
G="git --git-dir=.state.git --work-tree=."
git init --quiet --bare --initial-branch=main .state.git
$G config core.bare false
$G remote add origin git@github.com:jeaneclaude621-ui/threat_monitor-data.git
$G fetch --quiet origin main
$G reset --quiet --hard origin/main
