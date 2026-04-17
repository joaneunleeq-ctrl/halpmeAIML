#!/usr/bin/env bash
# halpmeAIML — Start the local embedding server
# Creates a virtualenv on first run, installs deps, starts FastAPI on port 5001

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/.venv"
REQ_FILE="${SCRIPT_DIR}/requirements.txt"
SERVER_FILE="${SCRIPT_DIR}/embedding-server.py"

echo "============================================"
echo "  halpmeAIML — Local Embedding Server"
echo "============================================"
echo ""

# Create virtualenv if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
  echo "Creating Python virtualenv at ${VENV_DIR} ..."
  python3 -m venv "$VENV_DIR"
  echo "Virtualenv created."
  echo ""
fi

# Activate virtualenv
source "${VENV_DIR}/bin/activate"

# Install/upgrade requirements
echo "Installing dependencies ..."
pip install --quiet --upgrade pip
pip install --quiet -r "$REQ_FILE"
echo "Dependencies installed."
echo ""

# Start the server
echo "Starting embedding server on http://localhost:5001 ..."
echo "Model: all-mpnet-base-v2 (768 dimensions)"
echo "Press Ctrl+C to stop."
echo ""

cd "$SCRIPT_DIR"
python embedding-server.py
