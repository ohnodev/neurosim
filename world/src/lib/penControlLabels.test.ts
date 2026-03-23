import { buildPenControlLabelMap } from './penControlLabels';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

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

  assert(labels.get('left-1') === 'L1', 'should use left control labels');
  assert(labels.get('right-1') === 'R1', 'should use right control labels');
  assert(labels.get('meta-only') === 'L2', 'should use metadata mapping labels');
  assert(labels.get('epg-only') === 'R2', 'should include labels from PEN->EPG connection rows');
  assert(labels.get('pen-only') === 'L3', 'should include source labels from PEN->PEN rows');
  assert(labels.get('target-only') === 'R3', 'should include target labels from PEN->PEN rows');
  assert(labels.get('unknown-left') === 'L1', 'should nearest-neighbor fallback by side (left)');
  assert(labels.get('unknown-right') === 'R1', 'should nearest-neighbor fallback by side (right)');
}

if (import.meta.env.MODE === 'test') {
  runBuildPenControlLabelMapTests();
}

