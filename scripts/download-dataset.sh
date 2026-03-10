#!/bin/bash
# Download FlyWire dataset from Kaggle into data/raw/
# Requires: kaggle.json in ~/.kaggle/ (from https://www.kaggle.com/settings)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RAW_DIR="$ROOT_DIR/data/raw"
mkdir -p "$RAW_DIR"

# Use project venv if kaggle not in PATH
if ! command -v kaggle &>/dev/null; then
  if [ -f "$ROOT_DIR/.venv/bin/kaggle" ]; then
    export PATH="$ROOT_DIR/.venv/bin:$PATH"
  else
    echo "Kaggle CLI not found. Run: cd $ROOT_DIR && python3 -m venv .venv && . .venv/bin/activate && pip install kaggle"
    echo "Then add ~/.kaggle/kaggle.json (from https://www.kaggle.com/settings)"
    exit 1
  fi
fi

if [ ! -f "$HOME/.kaggle/kaggle.json" ]; then
  echo "Missing ~/.kaggle/kaggle.json. Get API key from https://www.kaggle.com/settings"
  exit 1
fi

echo "Downloading FlyWire Brain Dataset..."
kaggle datasets download -d leonidblokhinrs/flywire-brain-dataset-fafb-v783 -p "$RAW_DIR" --unzip

echo "Done. Files in $RAW_DIR"
ls -la "$RAW_DIR"
