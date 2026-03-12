import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorldSource } from '../../../api/src/world';
import { subscribeSim, type FlyState } from '../lib/simWsClient';
import { type Snapshot, REST_DURATION_FALLBACK } from '../lib/flyInterpolation';
import { getApiBase } from '../lib/constants';
import { BrainOverlay } from './BrainOverlay';
import { SimRefsProvider, useSimDisplayData, useSimDisplayDataSelector } from '../lib/simDisplayContext';
import { ConnectButton } from './ConnectButton';
import { BuyFlyModal } from './BuyFlyModal';
import { initThreeScene, type InterpolationDebugStats, type CameraMode } from '../lib/threeScene';
import { DebugOverlay } from './DebugOverlay';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import './FlyViewer.css';

function getHungerColor(hunger: number): string {
  if (hunger > 50) return '#5a5';
  if (hunger > 20) return '#ca0';
  return '#c44';
}

function getHealthColor(health: number): string {
  if (health > 50) return '#48a';
  if (health > 20) return '#c95';
  return '#c44';
}

/** Bigint-safe ETH formatter to avoid precision loss. */
function formatEth(wei: bigint, decimals = 6): string {
  const ONE = 10n ** 18n;
  const whole = wei / ONE;
  const frac = wei % ONE;
  const fracStr = frac.toString().padStart(18, '0').slice(0, decimals);
  return `${whole}.${fracStr}`;
}

function safeAmountWei(val: string | undefined): bigint {
  if (val == null || val === "") return 0n;
  try {
    const n = BigInt(val);
    return n >= 0n ? n : 0n;
  } catch {
    return 0n;
  }
}

function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function RewardsTable({
  history,
  formatEth,
}: {
  history: { address: string; amountWei: string; timestamp: string; txHash?: string }[];
  formatEth: (wei: bigint) => string;
}) {
  const [copiedTx, setCopiedTx] = useState<string | null>(null);
  const copyTx = async (txHash: string) => {
    try {
      await navigator.clipboard.writeText(txHash);
      setCopiedTx(txHash);
      setTimeout(() => setCopiedTx(null), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="fly-viewer__rewards-table-wrap">
      <div className="fly-viewer__rewards-table">
        {history.length === 0 && <div style={{ color: '#666', padding: 8 }}>No rewards sent yet</div>}
        {history.slice().reverse().map((entry, i) => (
          <div key={`${entry.address}-${entry.timestamp}-${i}`} className="fly-viewer__rewards-row">
            <span className="fly-viewer__rewards-addr" title={entry.address}>{shortAddr(entry.address)}</span>
            <span className="fly-viewer__rewards-amount">{formatEth(safeAmountWei(entry.amountWei))}</span>
            <span className="fly-viewer__rewards-time" title={entry.timestamp}>
              {new Date(entry.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
            {entry.txHash ? (
              <span className="fly-viewer__rewards-actions">
                <button
                  type="button"
                  className="fly-viewer__rewards-action"
                  onClick={() => copyTx(entry.txHash!)}
                  aria-label="Copy tx"
                  title="Copy tx hash"
                >
                  {copiedTx === entry.txHash ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5" /></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  )}
                </button>
                <a
                  href={`https://basescan.org/tx/${entry.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="fly-viewer__rewards-action"
                  aria-label="View on BaseScan"
                  title="View on BaseScan"
                >
                  <img src="/basescan-logo.svg" alt="" width={12} height={12} />
                </a>
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const FLY_THRESHOLD = 1.1;

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(-8);
}

const DEFAULT_FLY: FlyState = { x: 0, y: 0, z: 0.35, heading: 0, t: 0, hunger: 100 };

interface ClaimedFly {
  id: string;
  method: string;
  claimedAt: string;
}

async function fetchMyFlies(address: string) {
  const r = await fetch(`${getApiBase()}/api/claim/my-flies?address=${address.toLowerCase()}`);
  if (!r.ok) return [];
  const data = await r.json();
  return (data.flies ?? []) as ClaimedFly[];
}

async function fetchMyDeployed(address: string): Promise<Record<number, number>> {
  const r = await fetch(`${getApiBase()}/api/deploy/my-deployed?address=${address.toLowerCase()}`);
  if (!r.ok) return {};
  const data = await r.json();
  return data.deployed ?? {};
}

async function fetchFlyStats(address: string): Promise<{ stats: { slotIndex: number; feedCount: number }[]; rewardPerPointWei: string }> {
  const r = await fetch(`${getApiBase()}/api/rewards/stats?address=${address.toLowerCase()}`);
  if (!r.ok) return { stats: [], rewardPerPointWei: (1000n * 10n ** 18n).toString() };
  const data = await r.json();
  const fallbackWei = (1000n * 10n ** 18n).toString(); // 1000 $NEURO per point
  return { stats: data.stats ?? [], rewardPerPointWei: data.rewardPerPointWei ?? fallbackWei };
}

function getFlyMode(fly: FlyState): string {
  if (fly.dead) return 'dead';
  if (fly.feeding) return 'feeding';
  if ((fly.z ?? 0) > FLY_THRESHOLD) return 'flying';
  if ((fly.z ?? 0) < 0.6) return 'resting';
  return 'idle';
}

function flyCardDataEqual(a: { fly: FlyState; points: number }, b: { fly: FlyState; points: number }): boolean {
  if (a.points !== b.points) return false;
  const fa = a.fly;
  const fb = b.fly;
  if (!!fa.dead !== !!fb.dead) return false;
  if ((fa.hunger ?? 100) !== (fb.hunger ?? 100)) return false;
  if ((fa.health ?? 100) !== (fb.health ?? 100)) return false;
  if ((fa.restTimeLeft ?? 0) !== (fb.restTimeLeft ?? 0)) return false;
  if ((fa.flyTimeLeft ?? 1) !== (fb.flyTimeLeft ?? 1)) return false;
  if ((fa.restDuration ?? REST_DURATION_FALLBACK) !== (fb.restDuration ?? REST_DURATION_FALLBACK)) return false;
  return true;
}

function FlyStatusCard({
  index,
  getFlyData,
  selected,
  onSelectSlot,
}: {
  index: number;
  getFlyData: (slotIndex: number) => { fly: FlyState; points: number };
  selected: boolean;
  onSelectSlot: (slotIndex: number) => void;
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
    }, 100);
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

const FlyStatusCardMemo = React.memo(FlyStatusCard);

/** Memoized static slot - graveyard, buy, deploy, connecting. Receives stable props only. */
const FlySlotGraveyard = React.memo(function FlySlotGraveyard({ index }: { index: number }) {
  return (
    <div className="fly-viewer__fly-slot-empty fly-viewer__fly-slot--in-graveyard">
      <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
      <span className="fly-viewer__fly-slot-label">Fly {index + 1}</span>
      <span style={{ fontSize: 9, color: '#666' }}>In graveyard</span>
    </div>
  );
});

const FlySlotBuy = React.memo(function FlySlotBuy({
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
});

const FlySlotDeploy = React.memo(function FlySlotDeploy({
  index,
  deployFly,
  setError,
}: {
  index: number;
  deployFly: (slotIndex: number) => Promise<void>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  return (
    <button
      type="button"
      className="fly-viewer__fly-slot-empty"
      onClick={async () => {
        try {
          await deployFly(index);
        } catch (e) {
          setError(e instanceof Error ? `Deploy failed: ${e.message}` : 'Deploy failed');
        }
      }}
    >
      <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
      <span className="fly-viewer__fly-slot-label">Fly {index + 1}</span>
      <span className="fly-viewer__fly-slot-buy">Deploy</span>
    </button>
  );
});

const CameraToggleButton = React.memo(function CameraToggleButton({
  cameraMode,
  setCameraMode,
}: {
  cameraMode: CameraMode;
  setCameraMode: (fn: (m: CameraMode) => CameraMode) => void;
}) {
  return (
    <button
      type="button"
      className="fly-viewer__camera-toggle"
      onClick={() => setCameraMode((m) => (m === 'god' ? 'fly' : 'god'))}
      title={cameraMode === 'god' ? 'Follow current fly' : 'Orbit view'}
      style={{
        padding: '6px 10px',
        fontSize: 11,
        fontFamily: 'var(--font-mono, monospace)',
        background: cameraMode === 'fly' ? 'rgba(35, 70, 138, 0.6)' : 'rgba(0,0,0,0.85)',
        color: '#aaf',
        border: '1px solid rgba(100,100,140,0.3)',
        borderRadius: 6,
        cursor: 'pointer',
      }}
    >
      {cameraMode === 'god' ? 'Fly view' : 'God view'}
    </button>
  );
});

const FlySlotConnecting = React.memo(function FlySlotConnecting({ index }: { index: number }) {
  return (
    <div className="fly-viewer__fly-slot-empty fly-viewer__fly-slot--connecting">
      <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
      <span className="fly-viewer__fly-slot-label">Fly {index + 1}</span>
      <span style={{ fontSize: 9, color: '#888' }}>Connecting…</span>
    </div>
  );
});

/** Syncs sim-derived refs; re-renders on interval, renders nothing. */
function SimStateSync({
  deployed,
  deployedSlotKeys,
  selectedFlyIndex,
  setSelectedFlyIndex,
  cameraMode,
  setCameraMode,
  cameraTargetRef,
  followSimIndexRef,
}: {
  deployed: Record<number, number>;
  deployedSlotKeys: number[];
  selectedFlyIndex: number;
  setSelectedFlyIndex: (v: number) => void;
  cameraMode: CameraMode;
  setCameraMode: (fn: (m: CameraMode) => CameraMode) => void;
  cameraTargetRef: React.MutableRefObject<{ x: number; y: number; z: number; heading: number } | null>;
  followSimIndexRef: React.MutableRefObject<number | undefined>;
}) {
  const { flies } = useSimDisplayData();
  const simIndexForSelected = deployed[selectedFlyIndex];
  const firstValidSlot = deployedSlotKeys.find(
    (slotIdx) => deployed[slotIdx] != null && flies[deployed[slotIdx]!] != null
  );
  const effectiveSimIndex =
    simIndexForSelected != null && flies[simIndexForSelected] != null
      ? simIndexForSelected
      : firstValidSlot != null
        ? deployed[firstValidSlot]!
        : undefined;
  const focusedFly =
    effectiveSimIndex != null && flies[effectiveSimIndex]
      ? flies[effectiveSimIndex]!
      : DEFAULT_FLY;

  useEffect(() => {
    followSimIndexRef.current = effectiveSimIndex;
  }, [effectiveSimIndex, followSimIndexRef]);

  useEffect(() => {
    if (effectiveSimIndex == null && cameraMode === 'fly') setCameraMode(() => 'god');
  }, [effectiveSimIndex, cameraMode, setCameraMode]);

  useEffect(() => {
    if (deployedSlotKeys.length === 0) return;
    const valid = simIndexForSelected != null && flies[simIndexForSelected] != null;
    if (!valid) {
      const firstValid = deployedSlotKeys.find(
        (slotIdx) => deployed[slotIdx] != null && flies[deployed[slotIdx]!] != null
      );
      setSelectedFlyIndex(firstValid ?? deployedSlotKeys[0]!);
    }
  }, [deployedSlotKeys, simIndexForSelected, flies, deployed, setSelectedFlyIndex]);

  useEffect(() => {
    if (effectiveSimIndex != null) {
      cameraTargetRef.current = {
        x: focusedFly.x ?? 0,
        y: focusedFly.y ?? 0,
        z: focusedFly.z ?? 0,
        heading: focusedFly.heading ?? 0,
      };
    } else {
      cameraTargetRef.current = null;
    }
  }, [effectiveSimIndex, focusedFly.x, focusedFly.y, focusedFly.z, focusedFly.heading, cameraTargetRef]);

  return null;
}

/** Top bar sim info (camera toggle, fly died, neuron count). Uses selector to re-render only when display values change. */
function TopBarSimInfo({
  deployed,
  selectedFlyIndex,
  cameraMode,
  setCameraMode,
  connected,
}: {
  deployed: Record<number, number>;
  selectedFlyIndex: number;
  cameraMode: CameraMode;
  setCameraMode: (fn: (m: CameraMode) => CameraMode) => void;
  connected: boolean;
}) {
  const { effectiveSimIndex, activeCount, flyDead } = useSimDisplayDataSelector(
    useCallback(
      (data: { flies: FlyState[]; activity: Record<string, number>; activities: (Record<string, number> | undefined)[] }) => {
        const { flies, activities, activity } = data;
        const simIndexForSelected = deployed[selectedFlyIndex];
        const firstValidSlot = Object.keys(deployed)
          .map((k) => parseInt(k, 10))
          .filter((n) => !Number.isNaN(n) && deployed[n] != null)
          .sort((a, b) => a - b)
          .find((slotIdx) => deployed[slotIdx] != null && flies[deployed[slotIdx]!] != null);
        const eff =
          simIndexForSelected != null && flies[simIndexForSelected] != null
            ? simIndexForSelected
            : firstValidSlot != null
              ? deployed[firstValidSlot]!
              : undefined;
        const focusedFly =
          eff != null && flies[eff] ? flies[eff]! : DEFAULT_FLY;
        const activityForSelected =
          eff != null && Array.isArray(activities) ? (activities[eff] ?? {}) : activity;
        return {
          effectiveSimIndex: eff,
          activeCount: Object.keys(activityForSelected).length,
          flyDead: !!focusedFly.dead,
        };
      },
      [deployed, selectedFlyIndex]
    )
  );

  return (
    <>
      {effectiveSimIndex != null && (
        <CameraToggleButton cameraMode={cameraMode} setCameraMode={setCameraMode} />
      )}
      {flyDead && (
        <div style={{ width: 120, padding: '6px 8px', background: '#422', color: '#f88', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
          Fly died
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: connected ? '#4ade80' : '#888' }}>
        {connected ? 'Sim running' : 'Connecting…'}
        {activeCount > 0 && <span style={{ color: 'rgba(255,255,255,0.6)' }}>Neurons: {activeCount}</span>}
      </div>
    </>
  );
}

/** Status tab body. Uses useSimDisplayData. */
function StatusPanelStatusContent({
  deployed,
  selectedFlyIndex,
  neuronLabels,
}: {
  deployed: Record<number, number>;
  selectedFlyIndex: number;
  neuronLabels: Record<string, string>;
}) {
  const { flies, activities, activity } = useSimDisplayData();
  const simIndexForSelected = deployed[selectedFlyIndex];
  const firstValidSlot = Object.keys(deployed)
    .map((k) => parseInt(k, 10))
    .filter((n) => !Number.isNaN(n) && deployed[n] != null)
    .sort((a, b) => a - b)
    .find((slotIdx) => deployed[slotIdx] != null && flies[deployed[slotIdx]!] != null);
  const effectiveSimIndex =
    simIndexForSelected != null && flies[simIndexForSelected] != null
      ? simIndexForSelected
      : firstValidSlot != null
        ? deployed[firstValidSlot]!
        : undefined;
  const focusedFly =
    effectiveSimIndex != null && flies[effectiveSimIndex]
      ? flies[effectiveSimIndex]!
      : DEFAULT_FLY;
  const activityForSelected =
    effectiveSimIndex != null && Array.isArray(activities)
      ? (activities[effectiveSimIndex] ?? {})
      : activity;
  const topActivity = Object.entries(activityForSelected)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);
  const flyMode = getFlyMode(focusedFly);
  const activeCount = Object.keys(activityForSelected).length;

  return (
    <div className="fly-viewer__status-tab-body">
      <div style={{ color: '#888', marginBottom: 6 }}>Fly {selectedFlyIndex + 1} (viewing)</div>
      <div style={{ marginBottom: 4 }}>pos ({(focusedFly.x ?? 0).toFixed(1)}, {(focusedFly.y ?? 0).toFixed(1)}, {(focusedFly.z ?? 0).toFixed(1)})</div>
      <div style={{ marginBottom: 4 }}>heading {((focusedFly.heading ?? 0) * 180 / Math.PI).toFixed(0)}° | {flyMode}</div>
      <div style={{ marginBottom: 8 }}>t {(focusedFly.t ?? 0).toFixed(1)}s | hunger {Math.round(focusedFly.hunger ?? 0)} | health {Math.round(focusedFly.health ?? 100)}</div>
      <div style={{ color: '#888', marginBottom: 4 }}>Firing neurons ({activeCount})</div>
      <div style={{ maxHeight: 120, overflow: 'auto' }}>
        {topActivity.length === 0 && <span style={{ color: '#666' }}>—</span>}
        {topActivity.map(([id, v]) => (
          <div key={id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, minWidth: 0 }} title={`${neuronLabels[id] || id}\n${id}`}>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{neuronLabels[id] || shortId(id)}</span>
            <span style={{ color: '#8cf', flexShrink: 0 }}>{(Math.min(v ?? 0, 1)).toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Current flies tab slots. Uses useSimDisplayData. Static slots memoized to avoid re-renders. */
function FliesPanelCurrentSlots({
  deployed,
  selectedFlyIndex,
  myFlies,
  graveyardSlots,
  statsBySlot,
  address,
  onSelectSlot,
  setGraveyardByWallet,
  setError,
  deployFly,
  setBuyFlySlot,
  getFlyCardData,
}: {
  deployed: Record<number, number>;
  selectedFlyIndex: number;
  myFlies: ClaimedFly[];
  graveyardSlots: Set<number>;
  statsBySlot: Record<number, number>;
  address: string | undefined;
  onSelectSlot: (slot: number) => void;
  setGraveyardByWallet: React.Dispatch<React.SetStateAction<Record<string, Set<number>>>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  deployFly: (slotIndex: number) => Promise<void>;
  setBuyFlySlot: (v: number | null) => void;
  getFlyCardData: (slotIndex: number) => { fly: FlyState; points: number };
}) {
  const { flies } = useSimDisplayData();

  return (
    <>
      <div className="fly-viewer__current-title">Current Flies</div>
      {[0, 1, 2].map((i) => {
        const inGraveyard = graveyardSlots.has(i);
        const hasFly = myFlies[i] != null;
        const simIdx = deployed[i];
        const isDeployed = simIdx != null;
        const hasSimFly = isDeployed && flies[simIdx] != null;
        const simFly = hasSimFly ? flies[simIdx]! : DEFAULT_FLY;
        const isDead = hasSimFly && simFly.dead;
        const isEmpty = myFlies.length === 0 && i === 0;
        return (
          <div key={i} className="fly-viewer__fly-slot">
            {inGraveyard ? (
              <FlySlotGraveyard index={i} />
            ) : !hasFly ? (
              <FlySlotBuy index={i} isEmpty={isEmpty} setBuyFlySlot={setBuyFlySlot} />
            ) : !isDeployed ? (
              <FlySlotDeploy index={i} deployFly={deployFly} setError={setError} />
            ) : isDeployed && !hasSimFly ? (
              <FlySlotConnecting index={i} />
            ) : isDead ? (
              <div className="fly-viewer__fly-slot-dead">
                <span className="fly-viewer__fly-slot-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  Fly {i + 1} (dead)
                  <span style={{ fontSize: 9, color: '#8a8', fontFamily: 'monospace' }}>{statsBySlot[i] ?? 0} pts</span>
                </span>
                <button
                  type="button"
                  className="fly-viewer__fly-slot-graveyard"
                  onClick={() => {
                    setGraveyardByWallet((prev) => {
                      const addr = address ?? '';
                      const set = new Set(prev[addr] ?? []);
                      set.add(i);
                      return { ...prev, [addr]: set };
                    });
                    const next = [0, 1, 2].find(
                      (j) =>
                        j !== i &&
                        !graveyardSlots.has(j) &&
                        deployed[j] != null &&
                        flies[deployed[j]!] != null
                    );
                    if (next != null && selectedFlyIndex === i) onSelectSlot(next);
                  }}
                >
                  Send to NeuroFly Graveyard
                </button>
              </div>
            ) : (
              <FlyStatusCardMemo
                index={i}
                getFlyData={getFlyCardData}
                selected={i === selectedFlyIndex}
                onSelectSlot={onSelectSlot}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export default function FlyViewer() {
  const { address } = usePrivyWallet();
  const queryClient = useQueryClient();
  const [selectedFlyIndex, setSelectedFlyIndex] = useState(0);
  const [sources, setSources] = useState<WorldSource[]>([]);
  const [neuronLabels, setNeuronLabels] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>('god');
  const [fliesPanelOpen, setFliesPanelOpen] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches ? false : true
  );
  const [buyFlySlot, setBuyFlySlot] = useState<number | null>(null);
  const [fliesTab, setFliesTab] = useState<'current' | 'graveyard'>('current');
  const [graveyardByWallet, setGraveyardByWallet] = useState<Record<string, Set<number>>>(() => ({}));
  const graveyardSlots = useMemo(
    () => graveyardByWallet[address ?? ''] ?? new Set(),
    [graveyardByWallet, address]
  );
  const isMobileDefault = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
  const [statusPanelOpen, setStatusPanelOpen] = useState(() => !isMobileDefault());
  const [statusTab, setStatusTab] = useState<'status' | 'rewards'>('status');
  const [brainPanelOpen, setBrainPanelOpen] = useState(() => !isMobileDefault());

  const snapshotBufferRef = useRef<Snapshot[]>([]);
  const latestFliesRef = useRef<FlyState[]>([]);
  const activityRef = useRef<Record<string, number>>({});
  const activitiesRef = useRef<(Record<string, number> | undefined)[]>([]);
  const debugStatsRef = useRef<InterpolationDebugStats | null>(null);
  const interpolatedBySimRef = useRef<FlyState[]>([]);
  const cameraModeRef = useRef<CameraMode>('god');
  const followSimIndexRef = useRef<number | undefined>(undefined);
  const sourcesRef = useRef<WorldSource[]>([]);
  const flyCardDataRef = useRef<Map<number, { fly: FlyState; points: number }>>(new Map());

  const { data: myFlies = [] } = useQuery({
    queryKey: ['my-flies', address ?? ''],
    queryFn: () => fetchMyFlies(address!),
    enabled: !!address,
  });

  const { data: deployed = {}, refetch: refetchDeployed } = useQuery({
    queryKey: ['my-deployed', address ?? ''],
    queryFn: () => fetchMyDeployed(address!),
    enabled: !!address,
  });

  const { data: rewardsHistory } = useQuery({
    queryKey: ['rewards-history'],
    queryFn: async () => {
      const r = await fetch(getApiBase() + '/api/rewards/history?limit=50');
      if (!r.ok) throw new Error('Failed to fetch');
      const j = await r.json();
      return (j.history ?? []) as { address: string; amountWei: string; timestamp: string; txHash?: string }[];
    },
    refetchInterval: connected ? 15_000 : false,
  });

  const { data: flyStatsData } = useQuery({
    queryKey: ['fly-stats', address ?? ''],
    queryFn: () => fetchFlyStats(address!),
    enabled: !!address,
    refetchInterval: connected ? 5000 : false,
  });
  const statsBySlot = useMemo(() => {
    const m: Record<number, number> = {};
    for (const s of flyStatsData?.stats ?? []) m[s.slotIndex] = s.feedCount;
    return m;
  }, [flyStatsData?.stats]);

  useEffect(() => {
    const apiBase = getApiBase();
    fetch(apiBase + '/api/world')
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(r.statusText)))
      .then((d) => {
        if (!Array.isArray(d.sources)) throw new Error('Invalid /api/world response');
        setSources(d.sources);
      })
      .catch((err) => {
        console.error('[FlyViewer] /api/world:', err);
        setError('Failed to load world');
      });
    fetch(apiBase + '/api/neurons')
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(r.statusText)))
      .then((d) => {
        if (!Array.isArray(d.neurons)) throw new Error('Invalid /api/neurons response');
        const list = d.neurons as { root_id: string; role?: string; cell_type?: string; x?: number; y?: number; z?: number }[];
        const labels: Record<string, string> = {};
        for (const n of list) {
          const full = [n.cell_type, n.role].filter(Boolean).join(' ') || n.root_id;
          labels[n.root_id] = full;
        }
        setNeuronLabels(labels);
      })
      .catch((err) => {
        console.error('[FlyViewer] /api/neurons:', err);
        setError('Failed to load neurons');
      });
  }, []);

  useEffect(() => {
    const unsub = subscribeSim((event) => {
      if ('_event' in event) {
        if (event._event === 'open') {
          setConnected(true);
          setError(null);
          snapshotBufferRef.current = [];
          latestFliesRef.current = [];
          activityRef.current = {};
          activitiesRef.current = [];
        } else if (event._event === 'closed') {
          setConnected(false);
        } else if (event._event === 'error') {
          setError(event.error);
        }
        return;
      }
      const data = event as {
        t?: number;
        flies?: FlyState[];
        fly?: FlyState;
        frames?: Snapshot[];
        activity?: Record<string, number>;
        activities?: (Record<string, number> | undefined)[];
        error?: string;
        sources?: WorldSource[];
      };
      if (data.error) setError(data.error);
      if (data.sources && Array.isArray(data.sources) && !(Array.isArray(data.frames) && data.frames.length > 0)) setSources(data.sources);
      if (!data.error) {
        const buf = snapshotBufferRef.current;
        const lastT = buf.length > 0 ? (buf[buf.length - 1]?.t ?? 0) : -Infinity;
        if (Array.isArray(data.frames) && data.frames.length > 0) {
          const firstNewT = data.frames[0]?.t ?? 0;
          if (firstNewT < lastT) buf.length = 0;
          for (const f of data.frames) {
            buf.push({
              t: f.t,
              flies: f.flies,
              activities: f.activities ?? [],
              activity: f.activity ?? f.activities?.[0],
              sources: f.sources,
            });
          }
          const maxT = buf[buf.length - 1]?.t ?? 0;
          while (buf.length > 1 && (buf[0]?.t ?? 0) < maxT - 1) buf.shift();
        } else {
          const fliesArr = Array.isArray(data.flies) ? data.flies : data.fly ? [data.fly] : null;
          if (fliesArr) {
            const newT = data.t ?? 0;
            if (newT < lastT) buf.length = 0;
            buf.push({
              t: newT,
              flies: fliesArr,
              activities: Array.isArray(data.activities) ? data.activities : [],
              activity: data.activity ?? data.activities?.[0],
            });
            const maxT = buf[buf.length - 1]?.t ?? 0;
            while (buf.length > 1 && (buf[0]?.t ?? 0) < maxT - 1) buf.shift();
          }
        }
        const last = buf[buf.length - 1];
        if (last) {
          latestFliesRef.current = last.flies;
          activityRef.current = last.activity ?? last.activities?.[0] ?? {};
          activitiesRef.current = last.activities ?? [];
        } else if (Array.isArray(data.flies)) {
          latestFliesRef.current = data.flies;
          activityRef.current = data.activity ?? data.activities?.[0] ?? {};
          activitiesRef.current = Array.isArray(data.activities) ? data.activities : [];
        } else if (data.fly) {
          latestFliesRef.current = [data.fly];
          activityRef.current = data.activity ?? data.activities?.[0] ?? {};
          activitiesRef.current = Array.isArray(data.activities) ? data.activities : [];
        }
        if (data.activity != null) activityRef.current = data.activity;
        else if (Array.isArray(data.activities) && data.activities[0] != null) activityRef.current = data.activities[0] ?? {};
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const flies = latestFliesRef.current;
      for (let i = 0; i < 3; i++) {
        const simIdx = deployed[i];
        const hasSimFly = simIdx != null && flies[simIdx] != null;
        const simFly = hasSimFly ? flies[simIdx]! : DEFAULT_FLY;
        const pts = statsBySlot[i] ?? 0;
        const next = { fly: simFly, points: pts };
        const prev = flyCardDataRef.current.get(i);
        if (!prev || !flyCardDataEqual(prev, next)) {
          flyCardDataRef.current.set(i, next);
        }
      }
    }, 200);
    return () => clearInterval(id);
  }, [deployed, statsBySlot]);

  const deployedSlotKeys = useMemo(
    () => Object.keys(deployed)
      .map((k) => parseInt(k, 10))
      .filter((n) => !Number.isNaN(n) && deployed[n] != null)
      .sort((a, b) => a - b),
    [deployed]
  );

  const onSelectFlySlot = useCallback((slot: number) => setSelectedFlyIndex(slot), []);

  const getFlyCardData = useCallback((slotIndex: number) => {
    const entry = flyCardDataRef.current.get(slotIndex);
    return entry ?? { fly: DEFAULT_FLY, points: 0 };
  }, []);

  const cameraTargetRef = useRef<{ x: number; y: number; z: number; heading: number } | null>(null);

  useEffect(() => {
    cameraModeRef.current = cameraMode;
    sourcesRef.current = sources;
  }, [cameraMode, sources]);

  useEffect(() => {
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:0';
    document.body.insertBefore(container, document.body.firstChild);

    const dispose = initThreeScene(container, {
      latestFliesRef,
      interpolatedBySimRef,
      debugStatsRef,
      cameraModeRef,
      followSimIndexRef,
      sourcesRef,
      snapshotBufferRef,
      targetRef: cameraTargetRef,
    });
    return () => {
      dispose();
      container.remove();
    };
  }, []);

  const simRefs = useMemo(
    () => ({
      latestFliesRef,
      activityRef,
      activitiesRef,
    }),
    []
  );

  const deployFly = async (slotIndex: number) => {
    if (!address) return;
    const r = await fetch(`${getApiBase()}/api/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address.toLowerCase(), slotIndex }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error ?? 'Deploy failed');
    }
    queryClient.invalidateQueries({ queryKey: ['my-deployed', address] });
    queryClient.invalidateQueries({ queryKey: ['fly-stats', address] });
    refetchDeployed();
  };

  return (
    <SimRefsProvider value={simRefs}>
      <SimStateSync
        deployed={deployed}
        deployedSlotKeys={deployedSlotKeys}
        selectedFlyIndex={selectedFlyIndex}
        setSelectedFlyIndex={setSelectedFlyIndex}
        cameraMode={cameraMode}
        setCameraMode={setCameraMode}
        cameraTargetRef={cameraTargetRef}
        followSimIndexRef={followSimIndexRef}
      />
      <div style={{ width: '100vw', height: '100vh', position: 'relative', pointerEvents: 'none' }}>
        {/* Canvas lives outside React (appended to body in useEffect) - no React re-renders */}
        {/* UI layer - always on top, always visible */}
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'none' }}>
          <DebugOverlay debugStatsRef={debugStatsRef} connected={connected} />
          {error && (
            <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', background: '#333', color: '#f88', padding: '8px 16px', borderRadius: 8, pointerEvents: 'auto' }}>
              {error}
            </div>
          )}
          <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, pointerEvents: 'auto' }}>
            <ConnectButton />
            <TopBarSimInfo
              deployed={deployed}
              selectedFlyIndex={selectedFlyIndex}
              cameraMode={cameraMode}
              setCameraMode={setCameraMode}
              connected={connected}
            />
          </div>
        <button
          type="button"
          className={`fly-viewer__flies-toggle ${fliesPanelOpen ? 'fly-viewer__flies-toggle--active' : ''}`}
          onClick={() => setFliesPanelOpen((o) => !o)}
          aria-label={fliesPanelOpen ? 'Hide flies panel' : 'Show flies panel'}
          aria-expanded={fliesPanelOpen}
          title={fliesPanelOpen ? 'Hide flies panel' : 'Show flies panel'}
        >
          <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
            <path d="M4 18V8h2v10H4zm6 0V4h2v14h-2zm6 0v-6h2v6h-2z" />
          </svg>
        </button>
        <div
          className={`fly-viewer__flies-overlay ${fliesPanelOpen ? 'fly-viewer__flies-overlay--open' : ''}`}
          id="flies-panel-overlay"
          inert={!fliesPanelOpen ? true : undefined}
          aria-hidden={!fliesPanelOpen}
        >
          <div className="fly-viewer__flies-panel">
            <div className="fly-viewer__flies-tabs">
              <button
                type="button"
                className={`fly-viewer__flies-tab ${fliesTab === 'current' ? 'fly-viewer__flies-tab--active' : ''}`}
                onClick={() => setFliesTab('current')}
              >
                <img src="/fly.svg" alt="" width={14} height={14} className="fly-viewer__tab-icon" aria-hidden />
                Current
              </button>
              <button
                type="button"
                className={`fly-viewer__flies-tab ${fliesTab === 'graveyard' ? 'fly-viewer__flies-tab--active' : ''}`}
                onClick={() => setFliesTab('graveyard')}
              >
                <img src="/tombstone.svg" alt="" width={14} height={14} className="fly-viewer__tab-icon fly-viewer__tab-icon--tombstone" aria-hidden />
                Graveyard
              </button>
            </div>
            {fliesTab === 'current' ? (
              <FliesPanelCurrentSlots
                deployed={deployed}
                selectedFlyIndex={selectedFlyIndex}
                myFlies={myFlies}
                graveyardSlots={graveyardSlots}
                statsBySlot={statsBySlot}
                address={address}
                onSelectSlot={onSelectFlySlot}
                setGraveyardByWallet={setGraveyardByWallet}
                setError={setError}
                deployFly={deployFly}
                setBuyFlySlot={setBuyFlySlot}
                getFlyCardData={getFlyCardData}
              />
            ) : (
              <>
                <div className="fly-viewer__graveyard-title">NeuroFly Graveyard</div>
                {[0, 1, 2].map((i) => {
                  const inGraveyard = graveyardSlots.has(i);
                  const pts = statsBySlot[i] ?? 0;
                  const wei = flyStatsData?.rewardPerPointWei ? BigInt(flyStatsData.rewardPerPointWei) * BigInt(pts) : 0n;
                  const ethStr = pts > 0 ? formatEth(wei) : '0';
                  return (
                    <div key={i} className={`fly-viewer__fly-slot fly-viewer__fly-slot--graveyard ${!inGraveyard ? 'fly-viewer__fly-slot--graveyard-empty' : ''}`}>
                      {inGraveyard ? (
                        <>
                          <img src="/fly.svg" alt="" width={20} height={20} className="fly-viewer__fly-slot-icon" aria-hidden />
                          <img src="/tombstone.svg" alt="" width={18} height={18} className="fly-viewer__graveyard-icon" aria-hidden />
                          <div className="fly-viewer__graveyard-fly-info">
                            <span className="fly-viewer__fly-slot-label">Fly {i + 1}</span>
                            <span className="fly-viewer__graveyard-stats">{pts} pts · {ethStr} $NEURO</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <img src="/tombstone.svg" alt="" width={18} height={18} className="fly-viewer__graveyard-icon" aria-hidden />
                          <span className="fly-viewer__fly-slot-label" style={{ color: '#555' }}>—</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
        {buyFlySlot != null && (
          <BuyFlyModal
            isOpen={true}
            onClose={() => setBuyFlySlot(null)}
            slotIndex={buyFlySlot}
            onSuccess={() => {
              if (address) queryClient.invalidateQueries({ queryKey: ['my-flies', address] });
            }}
          />
        )}
        {/* Left: Status panel + toggle (toggle moves with panel edge, same as Brain on right) */}
        <div className="fly-viewer__side-strip fly-viewer__side-strip--left">
          <div className={`fly-viewer__status-panel ${statusPanelOpen ? 'fly-viewer__status-panel--open' : ''}`}>
            <div className="fly-viewer__status-content">
              <div className="fly-viewer__status-tabs">
                <button
                  type="button"
                  className={`fly-viewer__status-tab ${statusTab === 'status' ? 'fly-viewer__status-tab--active' : ''}`}
                  onClick={() => setStatusTab('status')}
                >
                  Status
                </button>
                <button
                  type="button"
                  className={`fly-viewer__status-tab ${statusTab === 'rewards' ? 'fly-viewer__status-tab--active' : ''}`}
                  onClick={() => setStatusTab('rewards')}
                >
                  Rewards
                </button>
              </div>
              {statusTab === 'status' ? (
                <StatusPanelStatusContent
                  deployed={deployed}
                  selectedFlyIndex={selectedFlyIndex}
                  neuronLabels={neuronLabels}
                />
              ) : (
                <RewardsTable history={rewardsHistory ?? []} formatEth={formatEth} />
              )}
            </div>
          </div>
          <button
            type="button"
            className={`fly-viewer__side-toggle fly-viewer__side-toggle--status ${statusPanelOpen ? 'fly-viewer__side-toggle--active' : ''}`}
            onClick={() => setStatusPanelOpen((o) => !o)}
            aria-label={statusPanelOpen ? 'Hide status' : 'Show status'}
            aria-expanded={statusPanelOpen}
            title={statusPanelOpen ? 'Hide status' : 'Show status'}
          >
            <span className="fly-viewer__side-toggle-label">Status</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={statusPanelOpen ? 'M19 12H5M12 19l-7-7 7-7' : 'M5 12h14M12 5l7 7-7 7'} /></svg>
          </button>
        </div>
        {/* Right: Brain vertical toggle + panel */}
        <div className="fly-viewer__side-strip fly-viewer__side-strip--right">
          <div className={`fly-viewer__brain-panel ${brainPanelOpen ? 'fly-viewer__brain-panel--open' : ''}`}>
            <div className="fly-viewer__brain-content">
              <div style={{ color: '#888', marginBottom: 6 }}>Brain activity — Fly {selectedFlyIndex + 1} (viewing)</div>
              <div className="fly-viewer__brain-plot">
                <BrainOverlay followSimIndexRef={followSimIndexRef} visible={connected} embedded />
              </div>
            </div>
          </div>
          <button
            type="button"
            className={`fly-viewer__side-toggle fly-viewer__side-toggle--brain ${brainPanelOpen ? 'fly-viewer__side-toggle--active' : ''}`}
            onClick={() => setBrainPanelOpen((o) => !o)}
            aria-label={brainPanelOpen ? 'Hide brain activity' : 'Show brain activity'}
            aria-expanded={brainPanelOpen}
            title={brainPanelOpen ? 'Hide brain activity' : 'Show brain activity'}
          >
            <span className="fly-viewer__side-toggle-label">Brain</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={brainPanelOpen ? 'M5 12h14M12 5l7 7-7 7' : 'M19 12H5M12 19l-7-7 7-7'} /></svg>
          </button>
        </div>
      </div>
      </div>
    </SimRefsProvider>
  );
}
