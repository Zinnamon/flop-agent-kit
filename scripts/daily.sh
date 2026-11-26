#!/usr/bin/env bash
# One daily run of the kit: template agent (status, claim, buy one answer), then the digest.
# Meant for cron or launchd. Logs to $KIT_STATE_DIR/daily.log (default ~/.local/state/flop-agent-kit).
# Buys at most two answers a day: one for the agent, one for the digest (and none when nothing changed).
set -uo pipefail

kit="$(cd "$(dirname "$0")/.." && pwd)"
cd "$kit" || exit 1
state="${KIT_STATE_DIR:-$HOME/.local/state/flop-agent-kit}"
mkdir -p "$state"
log="$state/daily.log"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

{
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) daily run start"
  node src/agent/cli.js run "In two short sentences, what is a compute channel on the FLOP Network?"
  echo "----- agent exit code $?"
  node src/digest/digest.js
  echo "----- digest exit code $?"
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) daily run end"
} >> "$log" 2>&1
