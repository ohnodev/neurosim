import { describe, it, expect } from 'vitest';
import { loadConnectome, buildAdjacency } from './connectome.js';

describe('connectome', () => {
  it('loads fallback connectome when file missing', () => {
    const c = loadConnectome('/nonexistent/path.json');
    expect(c.neurons.length).toBeGreaterThan(0);
    expect(c.connections.length).toBeGreaterThan(0);
    expect(c.meta.total_neurons).toBe(c.neurons.length);
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
