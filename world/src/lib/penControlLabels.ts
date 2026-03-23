export interface PenControlNeuronRef {
  id: string;
  label: string;
}

export interface PenControlMetadata {
  mappingLabel?: string;
  side?: string;
  x?: number;
  y?: number;
  z?: number;
}

export interface PenControlConnectionRef {
  pen_id?: string;
  pen_label?: string;
  target_id?: string;
  target_label?: string;
  target_group?: 'epg' | 'pen_a';
}

export interface PenControlReplayNeuronRef {
  root_id: string;
  side?: string;
  x?: number;
  y?: number;
  z?: number;
}

interface BuildPenControlLabelMapArgs<TReplayNeuron extends PenControlReplayNeuronRef> {
  leftPenNeurons: PenControlNeuronRef[];
  rightPenNeurons: PenControlNeuronRef[];
  penMetadataById: Record<string, PenControlMetadata>;
  penEpgConnections: PenControlConnectionRef[];
  penPenConnections: PenControlConnectionRef[];
  replayNeurons: TReplayNeuron[] | undefined;
  isPenANeuron: (neuron: TReplayNeuron) => boolean;
}

export function buildPenControlLabelMap<TReplayNeuron extends PenControlReplayNeuronRef>({
  leftPenNeurons,
  rightPenNeurons,
  penMetadataById,
  penEpgConnections,
  penPenConnections,
  replayNeurons,
  isPenANeuron,
}: BuildPenControlLabelMapArgs<TReplayNeuron>): Map<string, string> {
  const out = new Map<string, string>();

  for (const { id, label } of leftPenNeurons) {
    const key = String(id ?? '').trim();
    if (key) out.set(key, label);
  }
  for (const { id, label } of rightPenNeurons) {
    const key = String(id ?? '').trim();
    if (key) out.set(key, label);
  }
  for (const [id, metadata] of Object.entries(penMetadataById)) {
    if (!out.has(id) && metadata.mappingLabel) out.set(id, metadata.mappingLabel);
  }
  for (const link of penEpgConnections) {
    const sourceId = String(link.pen_id ?? '').trim();
    if (sourceId && !out.has(sourceId) && link.pen_label) out.set(sourceId, link.pen_label);
  }
  for (const link of penPenConnections) {
    const sourceId = String(link.pen_id ?? '').trim();
    const targetId = String(link.target_id ?? '').trim();
    if (sourceId && !out.has(sourceId) && link.pen_label) out.set(sourceId, link.pen_label);
    if (link.target_group === 'pen_a' && targetId && !out.has(targetId) && link.target_label) {
      out.set(targetId, link.target_label);
    }
  }

  const refsBySide: { left: Array<{ x: number; y: number; z: number; label: string }>; right: Array<{ x: number; y: number; z: number; label: string }> } = {
    left: [],
    right: [],
  };
  for (const [id, label] of out) {
    const meta = penMetadataById[id];
    if (!meta || !Number.isFinite(meta.x) || !Number.isFinite(meta.y) || !Number.isFinite(meta.z)) continue;
    const sideRaw = (meta.side ?? '').toLowerCase();
    const side = sideRaw.startsWith('r') ? 'right' : 'left';
    refsBySide[side].push({ x: Number(meta.x), y: Number(meta.y), z: Number(meta.z), label });
  }

  if (replayNeurons?.length) {
    for (const neuron of replayNeurons) {
      if (!isPenANeuron(neuron)) continue;
      const neuronId = String(neuron.root_id ?? '').trim();
      if (!neuronId || out.has(neuronId)) continue;
      if (!Number.isFinite(neuron.x) || !Number.isFinite(neuron.y) || !Number.isFinite(neuron.z)) continue;

      const sideRaw = (neuron.side ?? '').toLowerCase();
      const preferred = sideRaw.startsWith('r') ? refsBySide.right : refsBySide.left;
      const candidates = preferred.length > 0 ? preferred : [...refsBySide.left, ...refsBySide.right];
      if (candidates.length === 0) continue;

      let best = candidates[0];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const c of candidates) {
        const dx = Number(neuron.x) - c.x;
        const dy = Number(neuron.y) - c.y;
        const dz = Number(neuron.z) - c.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDist) {
          bestDist = d2;
          best = c;
        }
      }
      out.set(neuronId, best.label);
    }
  }

  return out;
}
