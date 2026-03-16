import * as fs from 'node:fs';
import * as path from 'node:path';

type ClassificationRow = {
  root_id: string;
  flow: string;
  super_class: string;
  class: string;
  sub_class: string;
  cell_type: string;
  hemibrain_type: string;
  hemilineage: string;
  side: string;
  nerve: string;
};

type EpgTileEntry = {
  root_id: string;
  hemibrain_type: string;
  side: string;
  hemilineage: string;
  tile_index_0_7: number;
  tile_label: string;
  parsed_from: string;
};

const ROOT = path.resolve(process.cwd(), '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const CLASSIFICATION_PATH = path.join(RAW_DIR, 'classification.csv');
const PROCESSED_LABELS_PATH = path.join(RAW_DIR, 'processed_labels.csv');
const OUT_JSON = path.join(ROOT, 'data', 'epg-tile-map.json');
const OUT_CSV = path.join(ROOT, 'logs', 'epg_tile_map.csv');
const OUT_SUMMARY = path.join(ROOT, 'logs', 'epg_tile_map_summary.txt');

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function readClassification(): Map<string, ClassificationRow> {
  const txt = fs.readFileSync(CLASSIFICATION_PATH, 'utf8');
  const lines = txt.split('\n').filter((l) => l.trim().length > 0);
  const map = new Map<string, ClassificationRow>();
  for (let i = 1; i < lines.length; i += 1) {
    const c = parseCsvLine(lines[i] ?? '');
    if (c.length < 10) continue;
    map.set(c[0], {
      root_id: c[0],
      flow: c[1],
      super_class: c[2],
      class: c[3],
      sub_class: c[4],
      cell_type: c[5],
      hemibrain_type: c[6],
      hemilineage: c[7],
      side: c[8],
      nerve: c[9],
    });
  }
  return map;
}

function readProcessedLabels(): Map<string, string> {
  const txt = fs.readFileSync(PROCESSED_LABELS_PATH, 'utf8');
  const lines = txt.split('\n').filter((l) => l.trim().length > 0);
  const out = new Map<string, string>();
  for (let i = 1; i < lines.length; i += 1) {
    const c = parseCsvLine(lines[i] ?? '');
    if (c.length < 2) continue;
    out.set(c[0], c[1] ?? '');
  }
  return out;
}

function parseTileIndex(rawLabels: string): { tileIndex0_7: number; parsedFrom: string } | null {
  const epgMatch = rawLabels.match(/EPG_[LR](\d)/);
  if (epgMatch) {
    const n = Number(epgMatch[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 8) {
      return { tileIndex0_7: n - 1, parsedFrom: `EPG_${n}` };
    }
  }
  const epgtMatch = rawLabels.match(/EPGt_[LR](\d+)/);
  if (epgtMatch) {
    const n = Number(epgtMatch[1]);
    if (Number.isFinite(n) && n >= 1) {
      const folded = (n - 1) % 8;
      return { tileIndex0_7: folded, parsedFrom: `EPGt_${n}` };
    }
  }
  return null;
}

function main(): void {
  const classification = readClassification();
  const processedLabels = readProcessedLabels();

  const epgRows = [...classification.values()].filter(
    (r) => r.hemibrain_type === 'EPG' || r.hemibrain_type === 'EPGt',
  );

  const entries: EpgTileEntry[] = [];
  const missingTile: string[] = [];
  for (const row of epgRows) {
    const labels = processedLabels.get(row.root_id) ?? '';
    const parsed = parseTileIndex(labels);
    if (!parsed) {
      missingTile.push(row.root_id);
      continue;
    }
    entries.push({
      root_id: row.root_id,
      hemibrain_type: row.hemibrain_type,
      side: row.side,
      hemilineage: row.hemilineage,
      tile_index_0_7: parsed.tileIndex0_7,
      tile_label: `EPG${parsed.tileIndex0_7 + 1}`,
      parsed_from: parsed.parsedFrom,
    });
  }

  entries.sort((a, b) => a.tile_index_0_7 - b.tile_index_0_7 || a.root_id.localeCompare(b.root_id));

  const sideCounts = new Map<string, number>();
  const hemilineageCounts = new Map<string, number>();
  const tileCounts = new Map<number, number>();
  for (const e of entries) {
    sideCounts.set(e.side || 'unknown', (sideCounts.get(e.side || 'unknown') ?? 0) + 1);
    hemilineageCounts.set(e.hemilineage || 'unknown', (hemilineageCounts.get(e.hemilineage || 'unknown') ?? 0) + 1);
    tileCounts.set(e.tile_index_0_7, (tileCounts.get(e.tile_index_0_7) ?? 0) + 1);
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_SUMMARY), { recursive: true });

  fs.writeFileSync(OUT_JSON, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
  const csvLines = [
    'root_id,hemibrain_type,side,hemilineage,tile_index_0_7,tile_label,parsed_from',
    ...entries.map((e) => [
      e.root_id,
      e.hemibrain_type,
      e.side,
      e.hemilineage,
      String(e.tile_index_0_7),
      e.tile_label,
      e.parsed_from,
    ].join(',')),
  ];
  fs.writeFileSync(OUT_CSV, `${csvLines.join('\n')}\n`, 'utf8');

  const summaryLines = [
    'EPG tile map summary',
    `epg_rows_in_classification: ${epgRows.length}`,
    `mapped_entries: ${entries.length}`,
    `missing_tile_index: ${missingTile.length}`,
    `output_json: ${OUT_JSON}`,
    `output_csv: ${OUT_CSV}`,
    '',
    'side_counts:',
    ...[...sideCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'hemilineage_counts:',
    ...[...hemilineageCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'tile_counts:',
    ...[...tileCounts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `  tile_${k}: ${v}`),
  ];
  fs.writeFileSync(OUT_SUMMARY, `${summaryLines.join('\n')}\n`, 'utf8');

  console.log(`wrote ${OUT_JSON}`);
  console.log(`wrote ${OUT_CSV}`);
  console.log(`wrote ${OUT_SUMMARY}`);
}

main();
