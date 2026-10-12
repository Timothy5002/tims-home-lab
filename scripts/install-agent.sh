#!/bin/sh
# Install (or reinstall) one LaunchAgent from launchd/ and start it.
# Usage: scripts/install-agent.sh launchd/<label>.plist
set -eu
src=${1:?usage: install-agent.sh launchd/<label>.plist}
label=$(basename "$src" .plist)
dest="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

plutil -lint "$src"
mkdir -p "$HOME/Library/Logs/lab-dispatcher"
launchctl bootout "$domain/$label" 2>/dev/null || true
cp "$src" "$dest"
launchctl bootstrap "$domain" "$dest"
launchctl print "$domain/$label" | grep -E 'state|pid' || true
