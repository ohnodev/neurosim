import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadConnectome, buildAdjacency } from './connectome.js';

const FIXTURE = path.join(process.cwd(), 'connectome-fixture.json');

describe('connectome', () => {
  it('loadConnectome throws when file missing', () => {
    expect(() => loadConnectome('/nonexistent/connectome.json')).toThrow();
  });

  it('loadConnectome loads valid connectome', () => {
    const fixture = {
      neurons: [
        { root_id: 'n1', role: 'sensory' },
        { root_id: 'n2', role: 'motor', side: 'left' },
      ],
      connections: [{ pre: 'n1', post: 'n2', weight: 5 }],
      meta: { total_neurons: 2, total_connections: 1 },
    };
    fs.writeFileSync(FIXTURE, JSON.stringify(fixture));
    try {
      const c = loadConnectome(FIXTURE);
      expect(c.neurons).toHaveLength(2);
      expect(c.connections).toHaveLength(1);
    } finally {
      fs.unlinkSync(FIXTURE);
    }
  });

  it('buildAdjacency creates correct adjacency list', () => {
    const connections = [
      { pre: 'a', post: 'b', weight: 1 },
      { pre: 'a', post: 'c', weight: 2 },
    ];
    const adj = buildAdjacency(connections);
    expect(adj.get('a')).toHaveLength(2);
    expect(adj.get('b')).toBeUndefined();
  });
});
