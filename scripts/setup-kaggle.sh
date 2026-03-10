#!/bin/bash
# Setup Kaggle CLI for dataset download
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
cd "$ROOT"
python3 -m venv .venv
. .venv/bin/activate
pip install -q kaggle
echo "Kaggle installed in .venv"
echo ""
echo "Add your API key:"
echo "  1. Go to https://www.kaggle.com/settings"
echo "  2. Create API token (downloads kaggle.json)"
echo "  3. mkdir -p ~/.kaggle"
echo "  4. mv ~/Downloads/kaggle.json ~/.kaggle/"
echo "  5. chmod 600 ~/.kaggle/kaggle.json"
echo ""
echo "Then run: npm run download-dataset"
