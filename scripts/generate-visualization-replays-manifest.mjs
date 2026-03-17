import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd());
const publicDir = path.join(repoRoot, 'world', 'public');
const outPath = path.join(publicDir, 'visualization-replays.json');

const files = readdirSync(publicDir)
  .filter((name) => name.endsWith('_replay.json'))
  .sort((a, b) => a.localeCompare(b));

const datasets = files.map((name) => ({
  id: name.replace(/\.json$/i, ''),
  label: name.replace(/_replay\.json$/i, '').replaceAll('_', ' '),
  url: `/${name}`,
}));

const manifest = {
  generated_at: new Date().toISOString(),
  datasets,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`wrote ${outPath} datasets=${datasets.length}`);
