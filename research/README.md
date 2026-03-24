# NeuroSim Research App

Research manuscript frontend for the NeuroSim heading-bump project. This app hosts the paper text, figures, references, and reproducibility notes at `research.neurosim.fun`.

## Local Development

### Prerequisites

- Node.js 24.x (tested with `@types/node` 24 and Vite 8 toolchain)
- npm 10+
- Wrangler CLI (installed from project `devDependencies`)

### Install and run

```bash
npm install
npm run dev
```

The local Vite server starts on the default port (`5173` unless occupied).

### Build and preview

```bash
npm run build
npm run preview
```

## Project Structure

- `src/App.tsx`: manuscript content, figures, reference rendering, and theme toggle
- `src/App.css`: manuscript-scoped styling
- `src/components/CompactMenu.tsx`: top-right navigation menu used across pages
- `public/`: static figure/image assets used in manuscript
- `data/raw/`: local reference data used for mapping and analysis context (not fully tracked in git)

## Data, Analysis, and Figures

- Connectome/manuscript source data: Kaggle FlyWire dataset (`classification.csv` and related files) in `data/raw/`
- Figure assets included in app:
  - `public/hb-example.jpg`
  - `public/neurosim-biological-view.jpg`
- Code-accurate SVG figures are generated inline in `src/App.tsx`

## Deploy (Wrangler + Cloudflare)

The deploy script is configured in `package.json`:

```bash
npm run deploy
```

This runs:

1. `npm run build`
2. `wrangler deploy`

### Required Cloudflare setup

- Authenticated Wrangler session (`wrangler login`) or CI token
- Cloudflare account with access to the `research.neurosim.fun` route
- Valid `wrangler.jsonc` for project name/routes

If deploying from CI, set secrets/tokens through your CI environment (for example `CLOUDFLARE_API_TOKEN` and account-scoped values expected by Wrangler).

## Reproducibility Notes

- Frontend dependency versions are pinned in `package.json`:
  - React `^19.2.4`
  - Vite `^8.0.1`
  - TypeScript `~5.9.3`
- Use `npm ci` for deterministic installs in CI.
- Reproduce manuscript UI outputs with:
  1. `npm install`
  2. `npm run build`
  3. `npm run preview`
- Verify basic health with:
  - `npm run lint`
  - `npm run build`

For simulation-side numerical reproduction (Rust/CUDA engine, stimulation sweeps, and mapping pipeline), use the main NeuroSim repository and dataset snapshot documented in manuscript references.
