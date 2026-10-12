#!/bin/sh
# Test job: classifies four made-up sample emails with the local LLM helper (src/llm.js) to prove it works end to end.
set -u
HELPER="$(dirname "$0")/../src/llm.js"
START=$(date +%s)
BUDGET=55   # whole job must finish inside the dispatcher's 60s
FAILED=0

classify() {
  # $1 = short name for the printout; the email text arrives on stdin
  LEFT=$((BUDGET - ($(date +%s) - START)))
  [ "$LEFT" -gt 50 ] && LEFT=50
  if [ "$LEFT" -lt 3 ]; then echo "$1: skipped (out of time)"; FAILED=1; return; fi
  if OUT=$(node "$HELPER" classify --timeout "$LEFT" \
      --label "urgent=needs action today" \
      --label "reply=needs a personal response, but not today" \
      --label "fyi=informational, no action needed" \
      --label "noise=marketing, newsletters or automated promotions" 2>&1); then
    echo "$1: $OUT"
  else
    echo "$1: ERROR $OUT"; FAILED=1
  fi
}

classify "server-down" <<'EOF'
Subject: Production database is down
The main customer database stopped responding 10 minutes ago and checkout is failing. Need someone on this now.
EOF

classify "lunch-next-week" <<'EOF'
Subject: Lunch next week?
Hey, it's been a while. Want to grab lunch sometime next week? Let me know what day works for you.
EOF

classify "policy-update" <<'EOF'
Subject: Updated travel policy
Hi all, the updated travel policy is now on the intranet. No action needed; it takes effect next quarter.
EOF

classify "flash-sale" <<'EOF'
Subject: 48-HOUR FLASH SALE - 60% off everything!
Don't miss out on our biggest sale of the year. Shop now and use code SAVE60. Unsubscribe here.
EOF

echo "elapsed: $(($(date +%s) - START))s"
exit $FAILED
