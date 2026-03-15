#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RAW_CLASSIFICATION = path.resolve(ROOT, 'data', 'raw', 'classification.csv');
const CONNECTOME = path.resolve(ROOT, 'data', 'connectome-subset.json');

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parse(text, { columns: true, skip_empty_lines: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function norm(v) {
  return String(v ?? '').trim().toLowerCase();
}

function roleFromRaw(flow, superClass) {
  const f = norm(flow);
  const sc = norm(superClass);
  if (f === 'afferent') return 'sensory';
  if (f === 'efferent') return 'motor';
  if (sc === 'sensory' || sc === 'optic' || sc === 'ascending' || sc === 'visual_projection') return 'sensory';
  if (sc === 'descending' || sc === 'motor') return 'motor';
  return 'interneuron';
}

function isPhotoreceptor(cellType) {
  return /^r\d/i.test(String(cellType ?? '').trim());
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function countBy(arr, keyFn) {
  const m = new Map();
  for (const row of arr) bump(m, keyFn(row));
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
}

const args = process.argv.slice(2);
const idArg = args.find((a) => a.startsWith('--id='));
const ids = idArg
  ? idArg.slice('--id='.length).split(',').map((s) => s.trim()).filter(Boolean)
  : [];

if (!fs.existsSync(RAW_CLASSIFICATION)) {
  console.error(`Missing file: ${RAW_CLASSIFICATION}`);
  process.exit(1);
}
if (!fs.existsSync(CONNECTOME)) {
  console.error(`Missing file: ${CONNECTOME}`);
  process.exit(1);
}

const rawRows = readCsv(RAW_CLASSIFICATION);
const connectome = readJson(CONNECTOME);
const neurons = Array.isArray(connectome.neurons) ? connectome.neurons : [];

const rawById = new Map(rawRows.map((r) => [String(r.root_id), r]));
const mappedById = new Map(neurons.map((n) => [String(n.root_id), n]));

const afferentRows = rawRows.filter((r) => norm(r.flow) === 'afferent');
const afferentSensoryRows = rawRows.filter((r) => norm(r.flow) === 'afferent' && norm(r.super_class) === 'sensory');
const afferentVisualRows = rawRows.filter((r) => norm(r.flow) === 'afferent' && norm(r.class) === 'visual');
const afferentVisualPhotoRows = afferentVisualRows.filter((r) => isPhotoreceptor(r.cell_type));

const roleInConnectome = countBy(neurons, (n) => norm(n.role) || '<empty>');
const flowInRaw = countBy(rawRows, (r) => norm(r.flow) || '<empty>');
const superClassInRaw = countBy(rawRows, (r) => norm(r.super_class) || '<empty>');
const inferredRoleInRaw = countBy(rawRows, (r) => roleFromRaw(r.flow, r.super_class));

const afferentBySide = countBy(afferentRows, (r) => norm(r.side) || 'unknown');
const afferentVisualBySide = countBy(afferentVisualRows, (r) => norm(r.side) || 'unknown');
const afferentVisualPhotoBySide = countBy(afferentVisualPhotoRows, (r) => norm(r.side) || 'unknown');

const summary = {
  files: {
    classification: RAW_CLASSIFICATION,
    connectome: CONNECTOME,
  },
  totals: {
    raw_rows: rawRows.length,
    connectome_neurons: neurons.length,
  },
  raw_distribution: {
    flow: flowInRaw,
    super_class: superClassInRaw,
    inferred_role_from_raw: inferredRoleInRaw,
  },
  connectome_distribution: {
    role: roleInConnectome,
  },
  afferent_focus: {
    afferent_total: afferentRows.length,
    afferent_sensory_total: afferentSensoryRows.length,
    afferent_visual_total: afferentVisualRows.length,
    afferent_visual_photoreceptor_total: afferentVisualPhotoRows.length,
    afferent_by_side: afferentBySide,
    afferent_visual_by_side: afferentVisualBySide,
    afferent_visual_photoreceptor_by_side: afferentVisualPhotoBySide,
  },
};

console.log(JSON.stringify(summary, null, 2));

if (ids.length > 0) {
  const inspected = ids.map((id) => {
    const raw = rawById.get(id) ?? null;
    const mapped = mappedById.get(id) ?? null;
    return {
      root_id: id,
      raw: raw
        ? {
            flow: raw.flow,
            super_class: raw.super_class,
            class: raw.class,
            sub_class: raw.sub_class,
            cell_type: raw.cell_type,
            side: raw.side,
            inferred_role: roleFromRaw(raw.flow, raw.super_class),
          }
        : null,
      connectome: mapped
        ? {
            role: mapped.role,
            side: mapped.side,
            cell_type: mapped.cell_type,
          }
        : null,
    };
  });
  console.log('\n# ID audit');
  console.log(JSON.stringify(inspected, null, 2));
}
