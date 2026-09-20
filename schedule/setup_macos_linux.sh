#!/usr/bin/env bash
# macOS / Linux cron setup for the Hybrid Threat Monitor
#
# Run this once from inside the threat_monitor folder:
#   bash schedule/setup_macos_linux.sh
#
# It appends two cron entries: an hourly monitor run, and the 05:00
# daily consolidated report. It does NOT touch any of your existing
# cron entries.

set -e
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="$(command -v python3)"

if [ -z "$PYTHON_BIN" ]; then
  echo "python3 not found on PATH. Install Python 3 first." >&2
  exit 1
fi

CRON_MARKER="# threat-monitor (managed)"
HOURLY_LINE="0 * * * * cd $PROJECT_DIR && $PYTHON_BIN src/hourly_monitor.py >> data/logs/hourly_run.log 2>&1 $CRON_MARKER"
DAILY_LINE="0 5 * * * cd $PROJECT_DIR && $PYTHON_BIN src/daily_report.py >> data/logs/daily_run.log 2>&1 $CRON_MARKER"

( crontab -l 2>/dev/null | grep -v "$CRON_MARKER" ; echo "$HOURLY_LINE" ; echo "$DAILY_LINE" ) | crontab -

echo "Installed cron entries:"
crontab -l | grep "$CRON_MARKER"
echo ""
echo "NOTE: cron runs with a minimal environment - it will NOT see"
echo "ANTHROPIC_API_KEY just from your shell profile. Add it directly"
echo "to your crontab (run 'crontab -e' and add near the top):"
echo "  ANTHROPIC_API_KEY=sk-ant-...your-key..."
echo ""
echo "On macOS, if cron jobs don't fire, grant Terminal/cron 'Full Disk"
echo "Access' in System Settings > Privacy & Security, or use launchd instead."
