# EPG Driver Repro Guide (Do Not Lose)

This document captures the exact setup that reproduces EPG activation from an afferent-derived pathway in the current `fly-brain-fresh` + `neurosim` data stack.

## TL;DR

- Direct `olfactory -> EPG` and `visual -> EPG` edges are `0` in current connectivity.
- EPG can still be driven through intrinsic `CX` pathways.
- A specific top-10 afferent set is net-positive into a top-10 EPG-driver set.
- With this top-10 afferent set:
  - `100 ticks` (`dt=1ms`) -> drivers may spike a little, EPG stays silent.
  - `1000 ticks` (`dt=1ms`) -> drivers spike and EPG spikes.

## Source Files Created During Analysis

- `data/epg-driver-set.json`
- `data/epg-driver-set-top100.csv`
- `data/epg-pathway-summary.json`
- `data/epg-driver-upstream-afferent-analysis.csv`
- `data/epg-driver-upstream-afferent-summary.json`
- `data/epg-afferent-threshold-search.json`
- `data/epg-afferent-threshold-search.csv`
- `data/epg-hop1-driver-afferent-top10.json`

## Exact Top-10 Afferent Set (Working Set)

These are the afferent neurons ranked by net signed drive into the selected 10 presynaptic EPG-driver neurons:

1. `720575940626768442`
2. `720575940628644239`
3. `720575940622303446`
4. `720575940623302988`
5. `720575940623758377`
6. `720575940609713710`
7. `720575940612358642`
8. `720575940631844300`
9. `720575940622416628`
10. `720575940632875746`

## Exact Top-10 Presynaptic EPG Drivers

1. `720575940624452902`
2. `720575940617672226`
3. `720575940640749939`
4. `720575940642855328`
5. `720575940627264062`
6. `720575940612937073`
7. `720575940625653223`
8. `720575940610980932`
9. `720575940619845547`
10. `720575940624323475`

## Verified Signed Check (Afferent -> Driver)

For the 10 afferents above into the 10 drivers above:

- edge count: `21`
- total signed sum: `+32.0`
- positive signed sum: `+32.0`
- negative signed sum: `0.0`

So this is not a sign bug for this selected subgraph.

## Repro Command (PyTorch, No C++ Compile)

Run from `fly-brain-fresh`:

```bash
.venv/bin/python - <<'PY'
import json
from pathlib import Path
import pandas as pd
import torch
import sys
import os

root = Path(os.environ.get("DEV_HOME", Path.cwd().parent))
fly = root / 'fly-brain-fresh'
neuro = root / 'neurosim'

sys.path.insert(0, str(fly / 'code'))
import run_pytorch
from benchmark import path_comp, path_con, path_wt

run_pytorch.DT = 1.0  # 1 ms

aff10 = [
  720575940626768442, 720575940628644239, 720575940622303446, 720575940623302988,
  720575940623758377, 720575940609713710, 720575940612358642, 720575940631844300,
  720575940622416628, 720575940632875746,
]

drv10 = [
  720575940624452902, 720575940617672226, 720575940640749939, 720575940642855328,
  720575940627264062, 720575940612937073, 720575940625653223, 720575940610980932,
  720575940619845547, 720575940624323475,
]

epg_ids = sorted({int(e['root_id']) for e in json.loads((neuro / 'data' / 'epg-tile-map.json').read_text())['entries']})

flyid2i, _ = run_pytorch.get_hash_tables(str(path_comp))
aff_idx = [flyid2i[x] for x in aff10 if x in flyid2i]
drv_idx = [flyid2i[x] for x in drv10 if x in flyid2i]
epg_idx = [flyid2i[x] for x in epg_ids if x in flyid2i]

weights = run_pytorch.get_weights(str(path_con), str(path_comp), str(path_wt), csr=True).to('cpu')
model = run_pytorch.TorchModel(1, weights.shape[0], 1.0, run_pytorch.MODEL_PARAMS, weights, device='cpu')

def run_once(steps=1000, seed=123, hz=600.0):
    conductance, delay_buffer, spikes, v, refrac = model.state_init()
    rates = torch.zeros(1, weights.shape[0])
    rates[:, aff_idx] = hz
    gen = torch.Generator(device='cpu')
    gen.manual_seed(seed)
    d_spk = 0
    e_spk = 0
    with torch.no_grad():
        for _ in range(steps):
            conductance, delay_buffer, spikes, v, refrac = model(
                rates, conductance, delay_buffer, spikes, v, refrac, generator=gen
            )
            d_spk += int(spikes[0, drv_idx].sum().item())
            e_spk += int(spikes[0, epg_idx].sum().item())
    print(f"steps={steps} seed={seed} hz={hz} -> driver_spikes={d_spk}, epg_spikes={e_spk}")

run_once(steps=100)    # expected: tiny driver spikes, EPG often 0
run_once(steps=1000)   # expected: driver spikes + EPG spikes
PY
```

## Expected Behavior

Using `seed=123`, `dt=1ms`, `600Hz`, top-10 afferent set:

- `100 ticks` -> approximately `driver_spikes=3`, `epg_spikes=0`
- `1000 ticks` -> approximately `driver_spikes=77`, `epg_spikes=16`

This is the key non-intuitive result: same set, same rate, but duration is critical for EPG activation in this sparse pathway.

## Why This Matters

- The previously tested afferent sets were often high-connectivity but net ineffective for this specific EPG-driver slice.
- Ranking by net signed drive into presynaptic EPG drivers provides a reproducible set that does work at sufficient duration.
- This is a pathway/dynamics issue, not a C++ compile issue and not an obvious timestep off-by-10 bug.
