#!/usr/bin/env bash
# Checks what this Mac has and is missing to run the Hybrid Threat
# Monitor app. Changes NOTHING - purely diagnostic. Writes results to
# setup/env_check_results.txt for install_missing.sh to read, and
# prints a human-readable summary to the terminal.
#
# Usage:  bash setup/check_environment.sh

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_FILE="$SCRIPT_DIR/env_check_results.txt"

pass() { echo "  [OK]   $1"; }
fail() { echo "  [MISS] $1"; }

echo "Checking this Mac for what the Hybrid Threat Monitor app needs..."
echo ""
: > "$RESULTS_FILE"

# --- Architecture (Apple Silicon vs Intel - changes Homebrew's install path) ---
ARCH="$(uname -m)"
echo "ARCH=$ARCH" >> "$RESULTS_FILE"
echo "Detected: $(sw_vers -productName 2>/dev/null || echo macOS) $(sw_vers -productVersion 2>/dev/null), $ARCH"
echo ""

# --- Xcode Command Line Tools (only needed for the Homebrew path on Apple Silicon) ---
if [ "$ARCH" = "x86_64" ]; then
  pass "Xcode Command Line Tools not required for this install path"
  echo "CLT=n/a" >> "$RESULTS_FILE"
elif xcode-select -p >/dev/null 2>&1; then
  pass "Xcode Command Line Tools"
  echo "CLT=yes" >> "$RESULTS_FILE"
else
  fail "Xcode Command Line Tools (required before Homebrew can install)"
  echo "CLT=no" >> "$RESULTS_FILE"
fi

# --- Homebrew (Apple Silicon only - dropped Intel support Sept 2026) ---
if [ "$ARCH" = "x86_64" ]; then
  pass "Homebrew not needed on Intel - will install Python directly from python.org"
  echo "BREW=n/a" >> "$RESULTS_FILE"
elif command -v brew >/dev/null 2>&1 || [ -x /opt/homebrew/bin/brew ]; then
  pass "Homebrew"
  echo "BREW=yes" >> "$RESULTS_FILE"
else
  fail "Homebrew (package manager used to install Python on Apple Silicon)"
  echo "BREW=no" >> "$RESULTS_FILE"
fi

# --- Python 3.9+ ---
PY_OK="no"
if command -v python3 >/dev/null 2>&1; then
  PY_VER_NUM="$(python3 -c 'import sys; print(sys.version_info[0]*100+sys.version_info[1])' 2>/dev/null || echo 0)"
  PY_VER_STR="$(python3 --version 2>/dev/null)"
  if [ "$PY_VER_NUM" -ge 309 ] 2>/dev/null; then
    pass "$PY_VER_STR"
    PY_OK="yes"
  else
    fail "$PY_VER_STR found, but need 3.9 or newer"
  fi
else
  fail "Python 3 (not found)"
fi
echo "PYTHON=$PY_OK" >> "$RESULTS_FILE"

# --- pip ---
if [ "$PY_OK" = "yes" ] && python3 -m pip --version >/dev/null 2>&1; then
  pass "pip"
  echo "PIP=yes" >> "$RESULTS_FILE"
else
  fail "pip (Python's package installer)"
  echo "PIP=no" >> "$RESULTS_FILE"
fi

# --- This project's Python packages ---
DEPS_OK="no"
if [ "$PY_OK" = "yes" ]; then
  MISSING_DEPS=""
  for pkg in anthropic pptx; do
    python3 -c "import $pkg" >/dev/null 2>&1 || MISSING_DEPS="$MISSING_DEPS $pkg"
  done
  if [ -z "$MISSING_DEPS" ]; then
    pass "Required Python packages (anthropic, python-pptx)"
    DEPS_OK="yes"
  else
    fail "Missing Python packages:$MISSING_DEPS"
  fi
else
  fail "Python packages (can't check - Python 3 missing)"
fi
echo "DEPS=$DEPS_OK" >> "$RESULTS_FILE"

# --- API key (informational only - install script can't fix this one for you) ---
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  pass "ANTHROPIC_API_KEY is set in this terminal session"
  echo "APIKEY=yes" >> "$RESULTS_FILE"
else
  fail "ANTHROPIC_API_KEY not set (you'll add this yourself after signing up)"
  echo "APIKEY=no" >> "$RESULTS_FILE"
fi

echo ""
echo "Results saved to setup/env_check_results.txt"
echo "Next: bash setup/install_missing.sh"
