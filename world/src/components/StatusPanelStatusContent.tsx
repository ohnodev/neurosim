import { useStatusPanelData } from '../lib/simDisplayContext';
import { DEFAULT_FLY, getFlyMode, resolveEffectiveSimIndex, shortId } from '../lib/flyViewerUtils';

/** Status tab: shows focused fly position, heading, hunger, and top firing neurons. */
export function StatusPanelStatusContent({
  deployed,
  selectedFlyIndex,
  neuronLabels,
}: {
  deployed: Record<number, number>;
  selectedFlyIndex: number;
  neuronLabels: Record<string, string>;
}) {
  const { focusedFly, topActivity, activeCount } = useStatusPanelData(
    500,
    deployed,
    selectedFlyIndex,
    resolveEffectiveSimIndex,
    DEFAULT_FLY
  );
  const flyMode = getFlyMode(focusedFly);

  return (
    <div className="fly-viewer__status-tab-body">
      <div style={{ color: '#888', marginBottom: 6 }}>Fly {selectedFlyIndex + 1} (viewing)</div>
      <div style={{ marginBottom: 4 }}>
        pos ({(focusedFly.x ?? 0).toFixed(1)}, {(focusedFly.y ?? 0).toFixed(1)}, {(focusedFly.z ?? 0).toFixed(1)})
      </div>
      <div style={{ marginBottom: 4 }}>
        heading {(((focusedFly.heading ?? 0) * 180) / Math.PI).toFixed(0)}° | {flyMode}
      </div>
      <div style={{ marginBottom: 8 }}>
        t {(focusedFly.t ?? 0).toFixed(1)}s | hunger {Math.round(focusedFly.hunger ?? 0)} | health{' '}
        {Math.round(focusedFly.health ?? 100)}
      </div>
      <div style={{ color: '#888', marginBottom: 4 }}>Firing neurons ({activeCount})</div>
      <div style={{ maxHeight: 120, overflow: 'auto' }}>
        {topActivity.length === 0 && <span style={{ color: '#666' }}>—</span>}
        {topActivity.map(([id, v]) => (
          <div
            key={id}
            style={{ display: 'flex', justifyContent: 'space-between', gap: 12, minWidth: 0 }}
            title={`${neuronLabels[id] || id}\n${id}`}
          >
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {neuronLabels[id] || shortId(id)}
            </span>
            <span style={{ color: '#8cf', flexShrink: 0 }}>{(Math.min(v ?? 0, 1)).toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
