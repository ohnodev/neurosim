import React, { useState, useRef, useEffect } from 'react';
import type { FlyState } from '../../lib/simWsClient';
import { flyCardDataEqual } from '../../lib/flyViewerUtils';
import { getHealthColor, getHungerColor } from '../../lib/utils';
import { REST_DURATION_FALLBACK } from '../../lib/flyInterpolation';

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0));
}

export function FlySlotGraveyard({ index }: { index: number }) {
  return (
    <div className="fly-viewer__fly-slot-empty fly-viewer__fly-slot--in-graveyard">
      <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
      <span className="fly-viewer__fly-slot-label">Fly {index + 1}</span>
      <span style={{ fontSize: 9, color: '#666' }}>In graveyard</span>
    </div>
  );
}

function FlySlotBuyInner({
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

export const FlySlotBuy = React.memo(FlySlotBuyInner);

function FlySlotDeployInner({
  index,
  deployFly,
  disabled,
}: {
  index: number;
  deployFly: (slotIndex: number) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="fly-viewer__fly-slot-empty"
      disabled={!!disabled}
      onClick={() => deployFly(index)}
    >
      <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
      <span className="fly-viewer__fly-slot-label">Fly {index + 1}</span>
      <span className="fly-viewer__fly-slot-buy">Deploy</span>
    </button>
  );
}

export const FlySlotDeploy = React.memo(FlySlotDeployInner);

export function FlySlotDeploying({ index }: { index: number }) {
  return (
    <div className="fly-viewer__fly-slot-empty fly-viewer__fly-slot--connecting">
      <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
      <span className="fly-viewer__fly-slot-label">Fly {index + 1}</span>
      <span style={{ fontSize: 9, color: '#888' }}>Deploying…</span>
    </div>
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
}: {
  index: number;
  statsBySlot: Record<number, number>;
}) {
  return (
    <div className="fly-viewer__fly-slot-dead">
      <span className="fly-viewer__fly-slot-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Fly {index + 1} (dead)
        <span style={{ fontSize: 9, color: '#8a8', fontFamily: 'monospace' }}>{statsBySlot[index] ?? 0} pts</span>
      </span>
      <span style={{ fontSize: 10, color: '#888' }}>Moving to graveyard automatically...</span>
    </div>
  );
}

export function FlyStatusCard({
  index,
  getFlyData,
  subscribeTick,
  selected,
  onSelectSlot,
}: {
  index: number;
  getFlyData: (slotIndex: number) => { fly: FlyState; points: number };
  subscribeTick: (fn: () => void) => () => void;
  selected: boolean;
  onSelectSlot: (slot: number) => void;
}) {
  const [data, setData] = useState(() => getFlyData(index));
  const lastRef = useRef(data);

  useEffect(() => {
    const cb = () => {
      const next = getFlyData(index);
      if (!flyCardDataEqual(lastRef.current, next)) {
        lastRef.current = next;
        setData(next);
      }
    };
    return subscribeTick(cb);
  }, [index, getFlyData, subscribeTick]);

  const { fly, points } = data;
  const hunger = clampPct(fly.hunger ?? 100);
  const health = clampPct(fly.health ?? 100);
  const restDuration =
    (fly.restDuration != null && fly.restDuration > 0) ? fly.restDuration : REST_DURATION_FALLBACK;
  const fatiguePct = clampPct(
    fly.restTimeLeft != null && fly.restTimeLeft > 0
      ? 100 - ((fly.restTimeLeft ?? 0) / restDuration) * 100
      : (fly.flyTimeLeft ?? 1) * 100
  );
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
