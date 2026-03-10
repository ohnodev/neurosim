#!/bin/bash
# Download FlyWire dataset from Kaggle into data/raw/
# Requires: pip install kaggle, then place kaggle.json in ~/.kaggle/

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW_DIR="$(dirname "$SCRIPT_DIR")/data/raw"
mkdir -p "$RAW_DIR"

if ! command -v kaggle &>/dev/null; then
  echo "Kaggle CLI not found. Install with: pip install kaggle"
  echo "Then add your API key to ~/.kaggle/kaggle.json (from https://www.kaggle.com/settings)"
  exit 1
fi

echo "Downloading FlyWire Brain Dataset..."
kaggle datasets download -d leonidblokhinrs/flywire-brain-dataset-fafb-v783 -p "$RAW_DIR" --unzip

echo "Done. Files in $RAW_DIR"
ls -la "$RAW_DIR"
