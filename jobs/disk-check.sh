#!/bin/sh
# Daily disk check: reports free space on the internal drive and the 5 largest home folders; fails if free space is low.
set -u

MIN_FREE_PCT=25   # fail below this share of the drive free
MIN_FREE_GB=40    # ...or below this many GB free (decimal GB, as Finder shows)
VOLUME=/System/Volumes/Data   # the writable volume holding user data; "/" is the read-only system snapshot

# The dispatcher passes only PATH, so look the home folder up instead of trusting $HOME.
HOME_DIR=$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')
TMP=$(mktemp -d) || exit 2
trap 'rm -rf "$TMP"' EXIT

# Free space. df -k: column 2 = total KB, column 4 = available KB.
df -k "$VOLUME" | awk -v minpct="$MIN_FREE_PCT" -v mingb="$MIN_FREE_GB" '
  NR == 2 {
    total = $2 * 1024 / 1e9; free = $4 * 1024 / 1e9; pct = $4 / $2 * 100
    printf "Internal drive: %.1f GB free of %.1f GB (%.0f%% free)\n", free, total, pct
    low = (pct < minpct || free < mingb)
    printf "Thresholds: under %d%% or under %d GB free fails -> %s\n", minpct, mingb, low ? "LOW" : "OK"
    exit low ? 1 : 0
  }' > "$TMP/df.txt"
LOW=$?
cat "$TMP/df.txt"

# Largest folders directly inside home, measured one by one with du -x (stays on this drive).
# Under launchd, macOS privacy can make du wait on an "allow access" prompt forever instead of
# refusing, so each folder gets a few seconds (perl's alarm survives exec and kills du) and the
# whole scan has a budget. Blocked or slow folders are listed as unreadable, never as a failure:
# this job is about free space, not complete folder sizes.
PER_FOLDER_S=5
SCAN_BUDGET_S=40
START=$(date +%s)
: > "$TMP/sizes.txt"; : > "$TMP/skipped.txt"
for d in "$HOME_DIR"/* "$HOME_DIR"/.[!.]* "$HOME_DIR"/..?*; do
  [ -d "$d" ] && [ ! -L "$d" ] || continue
  name=${d#"$HOME_DIR"/}
  if [ $(($(date +%s) - START)) -ge "$SCAN_BUDGET_S" ]; then echo "$name (not scanned, out of time)" >> "$TMP/skipped.txt"; continue; fi
  if line=$(perl -e 'alarm shift; exec @ARGV' "$PER_FOLDER_S" du -xsk "$d" 2>> "$TMP/du-err.txt"); then
    echo "$line" >> "$TMP/sizes.txt"
  elif [ -n "$line" ]; then
    echo "$line" >> "$TMP/sizes.txt"   # partial size: some subfolders could not be read
  else
    echo "$name (blocked or slow)" >> "$TMP/skipped.txt"
  fi
done

echo
echo "Largest folders in $HOME_DIR:"
sort -rn "$TMP/sizes.txt" | head -5 | awk -v home="$HOME_DIR" '{
  path = $0; sub(/^[0-9]+[ \t]+/, "", path); sub("^" home "/", "", path)
  printf "  %8.1f GB  %s\n", $1 * 1024 / 1e9, path
}'
UNREADABLE=$(grep -c . "$TMP/du-err.txt")
[ "$UNREADABLE" -gt 0 ] && echo "  ($UNREADABLE subfolders unreadable, so some sizes may be low)"
if [ -s "$TMP/skipped.txt" ]; then
  echo "Unreadable folders (macOS privacy, left blocked on purpose):"
  sed 's/^/  /' "$TMP/skipped.txt"
fi

exit $LOW
