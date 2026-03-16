#!/usr/bin/env bash
set -euo pipefail

# Direct Fly-Brain -> CSV -> NeuroSim frontend public file.
# Does NOT start or use neurosim API / brain-service.
#
# Usage examples:
#   ./scripts/export-flybrain-csv.sh
#   T_RUN=0.1 N_RUN=1 BACKEND=--pytorch ./scripts/export-flybrain-csv.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

FLY_BRAIN_DIR="${FLY_BRAIN_DIR:-${REPO_ROOT}/../fly-brain}"
CONDA_ENV="${CONDA_ENV:-brain-fly}"
BACKEND="${BACKEND:---pytorch}"
T_RUN="${T_RUN:-0.1}"
N_RUN="${N_RUN:-1}"
OUT_CSV="${OUT_CSV:-${REPO_ROOT}/world/public/eonsystems_flybrain_spikes.csv}"

PARQUET_PATH="${FLY_BRAIN_DIR}/data/results/pytorch_t${T_RUN}s_n${N_RUN}.parquet"

echo "[1/3] Running fly-brain benchmark (${BACKEND}, t_run=${T_RUN}, n_run=${N_RUN})..."
conda run -n "${CONDA_ENV}" python "${FLY_BRAIN_DIR}/main.py" \
  "${BACKEND}" \
  --t_run "${T_RUN}" \
  --n_run "${N_RUN}" \
  --no_log_file || true

if [[ ! -f "${PARQUET_PATH}" ]]; then
  echo "Expected parquet not found: ${PARQUET_PATH}"
  echo "Adjust T_RUN/N_RUN/BACKEND or check fly-brain run logs."
  exit 1
fi

echo "[2/3] Converting parquet to CSV..."
conda run -n "${CONDA_ENV}" python -c "import pandas as pd; src='${PARQUET_PATH}'; out='${OUT_CSV}'; df=pd.read_parquet(src).sort_values(['trial','t','flywire_id']).reset_index(drop=True); df.to_csv(out,index=False); print(f'rows={len(df)} -> {out}')"

echo "[3/3] Done."
echo "Frontend CSV: ${OUT_CSV}"
