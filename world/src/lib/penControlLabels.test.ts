import { describe, expect, it } from 'vitest';
import { buildPenControlLabelMap } from './penControlLabels';

function runBuildPenControlLabelMapTests(): void {
  const replayNeurons = [
    { root_id: 'unknown-left', side: 'left', x: 1.1, y: 2.1, z: 3.1, kind: 'pen' },
    { root_id: 'unknown-right', side: 'right', x: 10.1, y: 11.1, z: 12.1, kind: 'pen' },
  ];
  const labels = buildPenControlLabelMap({
    leftPenNeurons: [{ id: 'left-1', label: 'L1' }],
    rightPenNeurons: [{ id: 'right-1', label: 'R1' }],
    penMetadataById: {
      'meta-only': { mappingLabel: 'L2' },
      'left-1': { side: 'left', x: 1, y: 2, z: 3 },
      'right-1': { side: 'right', x: 10, y: 11, z: 12 },
    },
    penEpgConnections: [{ pen_id: 'epg-only', pen_label: 'R2' }],
    penPenConnections: [
      { pen_id: 'pen-only', pen_label: 'L3', target_id: 'target-only', target_label: 'R3', target_group: 'pen_a' },
    ],
    replayNeurons,
    isPenANeuron: (n) => n.kind === 'pen',
  });

  expect(labels.get('left-1')).toBe('L1');
  expect(labels.get('right-1')).toBe('R1');
  expect(labels.get('meta-only')).toBe('L2');
  expect(labels.get('epg-only')).toBe('R2');
  expect(labels.get('pen-only')).toBe('L3');
  expect(labels.get('target-only')).toBe('R3');
  expect(labels.get('unknown-left')).toBe('L1');
  expect(labels.get('unknown-right')).toBe('R1');
}

describe('pen control label map', () => {
  it('builds correctly from all sources and fallback', () => {
    runBuildPenControlLabelMapTests();
  });
});

