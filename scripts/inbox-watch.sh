#!/usr/bin/env bash
# AV11: watch docs/agent-inbox.md on origin/main and exit as soon as this
# agent's section changes, so the background task wakes the agent.
# Usage (run in the background): bash scripts/inbox-watch.sh "Claude 2" [seconds]
# Reads only; changes nothing. Exits after ~2 hours so it never runs forever.
set -u
who="$1"; every="${2:-120}"
section() { git show origin/main:docs/agent-inbox.md 2>/dev/null | awk -v h="## $who" '$0==h{on=1;next} /^## /{on=0} on'; }
git fetch -q origin main 2>/dev/null; before="$(section | sha256sum)"
for _ in $(seq 1 $((7200 / every))); do
  sleep "$every"
  git fetch -q origin main 2>/dev/null || continue
  now="$(section | sha256sum)"
  if [ "$now" != "$before" ]; then
    echo "NEW MESSAGE for $who in docs/agent-inbox.md:"; section | tail -n 40; exit 0
  fi
done
echo "No new message for $who in 2 hours; start the watcher again."
