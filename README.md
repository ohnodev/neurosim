# NeuroSim

Fly brain emulation: FlyWire connectome + toy neural sim + 3D viewer.

**Flow**: Stimuli → neurons → brain sim → motor output → 3D fly. Run the World UI, connect your wallet, deploy a fly, and click "Start" to begin the simulation.

## Data Setup

The API loads `data/connectome-subset.json` at startup. On a fresh clone this file is missing; you must download the raw dataset and run the processor once.

### Option A – Kaggle CLI (recommended)

```bash
# 1. Install Kaggle CLI
npm run setup-kaggle
# Or manually: pip install kaggle

# 2. Add your API key (one-time)
# Go to https://www.kaggle.com/settings → Create API token
mkdir -p ~/.kaggle
mv ~/Downloads/kaggle.json ~/.kaggle/
chmod 600 ~/.kaggle/kaggle.json

# 3. Download dataset into data/raw/
npm run download-dataset

# 4. Process into connectome-subset.json
npm run process-connectome
```

### Option B – Manual download

1. Download [FlyWire Brain Dataset (FAFB v783)](https://www.kaggle.com/datasets/leonidblokhinrs/flywire-brain-dataset-fafb-v783/data) from Kaggle
2. Create `data/raw/` and extract these files from the ZIP:
   - `connections.csv` (required)
   - `coordinates.csv` (required)
   - `classification.csv` (required)
   - `consolidated_cell_types.csv` (required)
3. From repo root: `npm run process-connectome`

### After processing

Restart the API so it reloads the new connectome:

```bash
./pm2-manager.sh restart   # production
# or: cd api && npm run dev   # development
```

## Development

```bash
# Process connectome (after placing CSVs in data/raw/)
npm run process-connectome

# API
cd api && npm install && npm run dev

# World (separate terminal)
cd world && npm install && npm run dev
# Then open the local URL shown (e.g. http://localhost:5173), connect wallet, deploy a fly, and click Start.
```

## PM2 (production)

```bash
./pm2-manager.sh init
./pm2-manager.sh start
./pm2-manager.sh status
./pm2-manager.sh logs
./pm2-manager.sh restart
```

## Tests

```bash
npm test          # API unit tests + smoke (Vite build, optional API/PM2)
npm run test:api  # API unit tests only
```
