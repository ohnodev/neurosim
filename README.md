# NeuroSim

Fly brain emulation: FlyWire connectome + toy neural sim + 3D viewer.

**Flow**: Stimuli → neurons → brain sim → motor output → 3D fly. Click "Stimulate" in the UI to inject activity; the fly responds via connectome propagation.

## Data Setup

**Option A – Kaggle CLI**
```bash
pip install kaggle
# Add ~/.kaggle/kaggle.json (from kaggle.com/settings)
npm run download-dataset
```

**Option B – Manual**
1. Download [FlyWire Brain Dataset](https://www.kaggle.com/datasets/leonidblokhinrs/flywire-brain-dataset-fafb-v783/data)
2. Extract `connections.csv` (required), `neurons.csv`, `coordinates.csv` into `data/raw/`

Then: `npm run process-connectome`

## Development

```bash
# Process connectome (after placing CSVs in data/raw/)
npm run process-connectome

# API
cd api && npm install && npm run dev

# World (separate terminal)
cd world && npm install && npm run dev
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
