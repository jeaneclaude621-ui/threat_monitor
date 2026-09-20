#!/usr/bin/env bash
# Installs whatever setup/check_environment.sh found missing. Safe to
# re-run - skips anything already present. Run the check script first.
#
# Usage:  bash setup/install_missing.sh

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_FILE="$SCRIPT_DIR/env_check_results.txt"

if [ ! -f "$RESULTS_FILE" ]; then
  echo "No check results found yet. Run this first:"
  echo "  bash setup/check_environment.sh"
  exit 1
fi

# The results file is just KEY=value lines, safe to source directly.
source "$RESULTS_FILE"

echo "Installing based on setup/env_check_results.txt ..."
echo ""

if [ "${ARCH:-}" = "x86_64" ]; then
  # --- Intel Mac: Homebrew no longer installs here (dropped Sept 2026).
  #     Use the official python.org universal2 installer instead - no
  #     package manager needed, and no Xcode Command Line Tools either. ---
  if [ "${PYTHON:-no}" = "no" ]; then
    PY_PKG_VERSION="3.13.15"
    PY_PKG_URL="https://www.python.org/ftp/python/${PY_PKG_VERSION}/python-${PY_PKG_VERSION}-macos11.pkg"
    PY_PKG_FILE="/tmp/python-${PY_PKG_VERSION}-macos11.pkg"

    echo "Intel Mac detected. Homebrew dropped support for Intel Macs in"
    echo "September 2026, so this installs Python directly from the official"
    echo "python.org installer instead (same approach, just no package manager)."
    echo ""
    echo "Downloading Python ${PY_PKG_VERSION} from python.org..."
    curl -fL -o "$PY_PKG_FILE" "$PY_PKG_URL"

    echo "Installing (this will ask for your Mac login password)..."
    sudo installer -pkg "$PY_PKG_FILE" -target /
    rm -f "$PY_PKG_FILE"
    hash -r
  else
    echo "Python already present - skipping."
  fi
else
  # --- Apple Silicon: Xcode Command Line Tools -> Homebrew -> Python ---
  if [ "${CLT:-no}" = "no" ]; then
    echo "Xcode Command Line Tools are missing - Homebrew needs these first."
    echo "Triggering the install (a software-update window should open)..."
    xcode-select --install
    echo ""
    echo "Click 'Install' in the window that opened, wait for it to finish,"
    echo "then re-run:"
    echo "  bash setup/check_environment.sh && bash setup/install_missing.sh"
    exit 0
  fi

  if [ "${BREW:-no}" = "no" ]; then
    echo "Installing Homebrew (this may ask for your Mac login password)..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    echo ""
  fi

  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi

  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew was installed but isn't on PATH in this terminal yet."
    echo "Close this terminal, open a NEW one, and re-run:"
    echo "  bash setup/install_missing.sh"
    exit 1
  fi

  if [ "${PYTHON:-no}" = "no" ]; then
    echo "Installing Python 3 via Homebrew..."
    brew install python
    echo ""
  fi
  hash -r
fi

# --- Project's Python packages ---
echo "Installing required Python packages (anthropic, python-pptx)..."
if ! python3 -m pip install -r "$PROJECT_DIR/requirements.txt" 2>/tmp/tm_pip_err.log; then
  if grep -q "externally-managed-environment" /tmp/tm_pip_err.log; then
    echo "Homebrew's Python blocks unmanaged global installs by default;"
    echo "retrying with --break-system-packages (fine for this single-purpose app)."
    python3 -m pip install --break-system-packages -r "$PROJECT_DIR/requirements.txt"
  else
    echo "pip install failed:"
    cat /tmp/tm_pip_err.log
    exit 1
  fi
fi
rm -f /tmp/tm_pip_err.log

echo ""
echo "Re-checking..."
echo ""
bash "$SCRIPT_DIR/check_environment.sh"

echo ""
echo "If everything above shows [OK] except ANTHROPIC_API_KEY:"
echo "  1. Get a key at https://console.anthropic.com"
echo "  2. export ANTHROPIC_API_KEY=sk-ant-...your-key..."
echo "  3. python3 src/hourly_monitor.py    (test run)"
echo "  4. python3 src/daily_report.py      (test run)"
