import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const INPUT_PATH = path.resolve(ROOT, 'data', 'connectome-subset.json');
const OUTPUT_PATH = path.resolve(ROOT, 'world', 'public', 'connectome-viewer-10k.json');
const LIMIT = Math.max(1, Number(process.env.NEUROSIM_VIEWER_NEURON_LIMIT ?? 10_000));

function fnv1a32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function pickSubset(neurons, limit) {
  if (neurons.length <= limit) {
    return neurons.map((n, i) => ({ n, i }));
  }
  return neurons
    .map((n, i) => ({ n, i, h: fnv1a32(n.root_id) }))
    .sort((a, b) => (a.h - b.h) || (a.i - b.i))
    .slice(0, limit)
    .sort((a, b) => a.i - b.i);
}

async function main() {
  const raw = await fs.readFile(INPUT_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const neurons = Array.isArray(parsed?.neurons) ? parsed.neurons : [];
  if (neurons.length === 0) {
    throw new Error(`No neurons found in ${INPUT_PATH}`);
  }

  const subset = pickSubset(neurons, LIMIT).map(({ n }) => ({
    root_id: String(n.root_id),
    ...(typeof n.role === 'string' && n.role.length > 0 ? { role: n.role } : {}),
    ...(typeof n.side === 'string' && n.side.length > 0 ? { side: n.side } : {}),
    ...(typeof n.cell_type === 'string' && n.cell_type.length > 0 ? { cell_type: n.cell_type } : {}),
    ...(typeof n.x === 'number' && Number.isFinite(n.x) ? { x: n.x } : {}),
    ...(typeof n.y === 'number' && Number.isFinite(n.y) ? { y: n.y } : {}),
    ...(typeof n.z === 'number' && Number.isFinite(n.z) ? { z: n.z } : {}),
  }));

  const output = {
    meta: {
      source: 'data/connectome-subset.json',
      algorithm: 'fnv1a32-sorted-root-id',
      viewer_neuron_limit: LIMIT,
      subset_neurons: subset.length,
      total_neurons: neurons.length,
      generated_at: new Date().toISOString(),
    },
    neurons: subset,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output));
  console.log(`[viewer-connectome] wrote ${subset.length} neurons to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('[viewer-connectome] failed:', err);
  process.exit(1);
});
