import React, { useState, useRef, useEffect } from 'react';
import type { FlyState } from '../../lib/simWsClient';
import { flyCardDataEqual } from '../../lib/flyViewerUtils';
import { getHealthColor, getHungerColor } from '../../lib/utils';
import { REST_DURATION_FALLBACK } from '../../lib/flyInterpolation';

export function FlySlotGraveyard({ index }: { index: number }) {
  return (
    <div className="fly-viewer__fly-slot-empty fly-viewer__fly-slot--in-graveyard">
      <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
      <span className="fly-viewer__fly-slot-label">Fly {index + 1}</span>
      <span style={{ fontSize: 9, color: '#666' }}>In graveyard</span>
    </div>
  );
}

export function FlySlotBuy({
  index,
  isEmpty,
  setBuyFlySlot,
}: {
  index: number;
  isEmpty: boolean;
  setBuyFlySlot: (v: number | null) => void;
}) {
  return (
    <button
      type="button"
      className={`fly-viewer__fly-slot-empty ${isEmpty ? 'fly-viewer__fly-slot-empty--first' : ''}`}
      onClick={() => setBuyFlySlot(index)}
    >
      <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
      <span className="fly-viewer__fly-slot-label">Fly {index + 1}</span>
      <span className="fly-viewer__fly-slot-buy">Buy NeuroFly</span>
    </button>
  );
}

export function FlySlotDeploy({
  index,
  deployFly,
  setError,
}: {
  index: number;
  deployFly: (slotIndex: number) => Promise<void>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const [isDeploying, setIsDeploying] = useState(false);
  return (
    <button
      type="button"
      className="fly-viewer__fly-slot-empty"
      disabled={isDeploying}
      onClick={async () => {
        if (isDeploying) return;
        setIsDeploying(true);
        try {
          await deployFly(index);
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? `Deploy failed: ${e.message}` : 'Deploy failed');
        } finally {
          setIsDeploying(false);
        }
      }}
    >
      <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
      <span className="fly-viewer__fly-slot-label">Fly {index + 1}</span>
      <span className="fly-viewer__fly-slot-buy">Deploy</span>
    </button>
  );
}

export function FlySlotConnecting({ index }: { index: number }) {
  return (
    <div className="fly-viewer__fly-slot-empty fly-viewer__fly-slot--connecting">
      <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
      <span className="fly-viewer__fly-slot-label">Fly {index + 1}</span>
      <span style={{ fontSize: 9, color: '#888' }}>Connecting…</span>
    </div>
  );
}

export function FlySlotDead({
  index,
  statsBySlot,
  address,
  graveyardSlots,
  deployed,
  selectedFlyIndex,
  onSelectSlot,
  setGraveyardByWallet,
  latestFliesRef,
}: {
  index: number;
  statsBySlot: Record<number, number>;
  address: string | undefined;
  graveyardSlots: Set<number>;
  deployed: Record<number, number>;
  selectedFlyIndex: number;
  onSelectSlot: (slot: number) => void;
  setGraveyardByWallet: React.Dispatch<React.SetStateAction<Record<string, Set<number>>>>;
  latestFliesRef: React.MutableRefObject<FlyState[]>;
}) {
  return (
    <div className="fly-viewer__fly-slot-dead">
      <span className="fly-viewer__fly-slot-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Fly {index + 1} (dead)
        <span style={{ fontSize: 9, color: '#8a8', fontFamily: 'monospace' }}>{statsBySlot[index] ?? 0} pts</span>
      </span>
      <button
        type="button"
        className="fly-viewer__fly-slot-graveyard"
        onClick={() => {
          setGraveyardByWallet((prev) => {
            const addr = address ?? '';
            const set = new Set(prev[addr] ?? []);
            set.add(index);
            return { ...prev, [addr]: set };
          });
          const flies = latestFliesRef.current;
          const next = [0, 1, 2].find(
            (j) =>
              j !== index &&
              !graveyardSlots.has(j) &&
              deployed[j] != null &&
              flies[deployed[j]!] != null
          );
          if (next != null && selectedFlyIndex === index) onSelectSlot(next);
        }}
      >
        Send to NeuroFly Graveyard
      </button>
    </div>
  );
}

export function FlyStatusCard({
  index,
  getFlyData,
  selected,
  onSelectSlot,
}: {
  index: number;
  getFlyData: (slotIndex: number) => { fly: FlyState; points: number };
  selected: boolean;
  onSelectSlot: (slot: number) => void;
}) {
  const [data, setData] = useState(() => getFlyData(index));
  const lastRef = useRef(data);

  useEffect(() => {
    const id = setInterval(() => {
      const next = getFlyData(index);
      if (!flyCardDataEqual(lastRef.current, next)) {
        lastRef.current = next;
        setData(next);
      }
    }, 200);
    return () => clearInterval(id);
  }, [index, getFlyData]);

  const { fly, points } = data;
  const hunger = fly.hunger ?? 100;
  const health = fly.health ?? 100;
  const fatiguePct =
    fly.restTimeLeft != null && fly.restTimeLeft > 0
      ? 100 - ((fly.restTimeLeft ?? 0) / (fly.restDuration ?? REST_DURATION_FALLBACK)) * 100
      : (fly.flyTimeLeft ?? 1) * 100;
  return (
    <button
      type="button"
      className="fly-viewer__status-card"
      onClick={() => onSelectSlot(index)}
      style={{
        width: '100%',
        textAlign: 'left',
        border: '1px solid rgba(255,255,255,0.08)',
        background: selected ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.04)',
        borderRadius: 6,
        padding: 8,
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: selected ? '#aaf' : '#aaa', marginBottom: 6, fontWeight: 600 }}>
        <span>Fly {index + 1}{selected ? ' (viewing)' : ''}</span>
        <span style={{ fontSize: 9, color: '#8a8', fontFamily: 'monospace' }}>{points} pts</span>
      </div>
      {fly.dead ? (
        <div style={{ fontSize: 10, color: '#f88' }}>dead</div>
      ) : (
        <>
          <div style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 9, color: '#888', marginBottom: 2 }}>Hunger</div>
            <div style={{ position: 'relative', height: 8, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${hunger}%`, height: '100%', background: getHungerColor(hunger), transition: 'width 0.2s' }} />
              <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontFamily: 'monospace', color: '#fff', textShadow: '0 0 2px #000, 0 1px 1px #000', pointerEvents: 'none' }}>{Math.round(hunger)}/100</span>
            </div>
          </div>
          <div style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 9, color: '#888', marginBottom: 2 }}>Health</div>
            <div style={{ position: 'relative', height: 8, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${health}%`, height: '100%', background: getHealthColor(health), transition: 'width 0.2s' }} />
              <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontFamily: 'monospace', color: '#fff', textShadow: '0 0 2px #000, 0 1px 1px #000', pointerEvents: 'none' }}>{Math.round(health)}/100</span>
            </div>
          </div>
          <div style={{ marginBottom: 0 }}>
            <div style={{ fontSize: 9, color: '#888', marginBottom: 2 }}>Fatigue</div>
            <div style={{ position: 'relative', height: 8, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${fatiguePct}%`, height: '100%', background: '#48a', transition: 'width 0.2s' }} />
              <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontFamily: 'monospace', color: '#fff', textShadow: '0 0 2px #000, 0 1px 1px #000', pointerEvents: 'none' }}>{Math.round(fatiguePct)}/100</span>
            </div>
          </div>
        </>
      )}
    </button>
  );
}

export const FlyStatusCardMemo = React.memo(FlyStatusCard);
