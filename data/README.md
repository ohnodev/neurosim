# Data directory

The API loads `connectome-subset.json` at startup. On a fresh clone this file does not exist; you must download the FlyWire dataset and run the processor.

## Quick setup (Kaggle CLI)

```bash
# From repo root
npm run setup-kaggle          # install Kaggle CLI (optional)
# Add ~/.kaggle/kaggle.json from https://www.kaggle.com/settings
npm run download-dataset      # downloads into data/raw/
npm run process-connectome    # writes data/connectome-subset.json
```

## Manual setup

1. Download [FlyWire Brain Dataset (FAFB v783)](https://www.kaggle.com/datasets/leonidblokhinrs/flywire-brain-dataset-fafb-v783/data)
2. Create `data/raw/` and extract from the ZIP:
   - `connections.csv`
   - `coordinates.csv`
   - `classification.csv`
   - `consolidated_cell_types.csv`
3. From repo root: `npm run process-connectome`

## Output

`connectome-subset.json` is written to this directory. The API reads it at startup. Use `SUBSET_SIZE=0` or `--all` for the full connectome (larger file).
