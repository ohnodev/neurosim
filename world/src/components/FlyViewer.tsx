import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorldSource } from '../../../api/src/world';
import { subscribeSim, type FlyState } from '../lib/simWsClient';
import { type Snapshot, MAX_SNAPSHOT_BUFFER } from '../lib/flyInterpolation';
import { getApiBase } from '../lib/constants';
import {
  apiKeys,
  fetchWorld,
  fetchNeurons,
  fetchMyFlies,
  fetchMyDeployed,
  fetchFlyStats,
  type ClaimedFly,
  type NeuronRaw,
} from '../lib/api';
import { BrainOverlay } from './BrainOverlay';
import { SimRefsProvider, useSimRefs, useSimDisplayDataSelector } from '../lib/simDisplayContext';
import { ConnectButton } from './ConnectButton';
import { BuyFlyModal } from './BuyFlyModal';
import { initThreeScene, type InterpolationDebugStats, type CameraMode, type SimStatusRefs } from '../lib/threeScene';
// import { DebugOverlay } from './DebugOverlay';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { formatEth } from '../lib/utils';
import { RewardsTable } from './RewardsTable';
import { StatusPanelStatusContent } from './StatusPanelStatusContent';
import { DEFAULT_FLY, flyCardDataEqual, resolveEffectiveSimIndex } from '../lib/flyViewerUtils';
import {
  FlySlotBuy,
  FlySlotConnecting,
  FlySlotDead,
  FlySlotDeploy,
  FlySlotGraveyard,
  FlyStatusCardMemo,
} from './FlySlots';
import './FlyViewer.css';

const CameraToggleSlot = React.memo(
  React.forwardRef<
    HTMLDivElement,
    { deployed: Record<number, number>; selectedFlyIndex: number }
  >(function CameraToggleSlot({ deployed, selectedFlyIndex }, ref) {
    const { effectiveSimIndex } = useSimDisplayDataSelector(
      useCallback(
        (data: { flies: FlyState[] }) => ({
          effectiveSimIndex: resolveEffectiveSimIndex(data.flies, deployed, selectedFlyIndex),
        }),
        [deployed, selectedFlyIndex]
      )
    );
    return (
      <div
        ref={ref}
        style={{ display: effectiveSimIndex == null ? 'none' : undefined }}
      />
    );
  })
);

/** Syncs sim-derived refs; re-renders on interval, renders nothing. */
function SimStateSync({
  deployed,
  deployedSlotKeys,
  selectedFlyIndex,
  setSelectedFlyIndex,
  cameraModeRef,
  updateCameraButtonRef,
  cameraTargetRef,
  followSimIndexRef,
}: {
  deployed: Record<number, number>;
  deployedSlotKeys: number[];
  selectedFlyIndex: number;
  setSelectedFlyIndex: (v: number) => void;
  cameraModeRef: React.MutableRefObject<CameraMode>;
  updateCameraButtonRef: React.MutableRefObject<((mode: CameraMode) => void) | null>;
  cameraTargetRef: React.MutableRefObject<{ x: number; y: number; z: number; heading: number } | null>;
  followSimIndexRef: React.MutableRefObject<number | undefined>;
}) {
  const { latestFliesRef } = useSimRefs();

  useEffect(() => {
    const id = setInterval(() => {
      const flies = latestFliesRef.current;
      const effectiveSimIndex = resolveEffectiveSimIndex(flies, deployed, selectedFlyIndex, deployedSlotKeys);
      const simIndexForSelected = deployed[selectedFlyIndex];
      const focusedFly =
        effectiveSimIndex != null && flies[effectiveSimIndex]
          ? flies[effectiveSimIndex]!
          : DEFAULT_FLY;

      followSimIndexRef.current = effectiveSimIndex;

      if (effectiveSimIndex == null && cameraModeRef.current === 'fly') {
        cameraModeRef.current = 'god';
        updateCameraButtonRef.current?.('god');
      }

      if (deployedSlotKeys.length > 0) {
        const valid = simIndexForSelected != null && flies[simIndexForSelected] != null;
        if (!valid) {
          const firstValid = deployedSlotKeys.find(
            (slotIdx) => deployed[slotIdx] != null && flies[deployed[slotIdx]!] != null
          );
          setSelectedFlyIndex(firstValid ?? deployedSlotKeys[0]!);
        }
      }

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
    }, 200);
    return () => clearInterval(id);
  }, [
    latestFliesRef,
    deployed,
    deployedSlotKeys,
    selectedFlyIndex,
    setSelectedFlyIndex,
    cameraModeRef,
    updateCameraButtonRef,
    cameraTargetRef,
    followSimIndexRef,
  ]);

  return null;
}

/** Imperative sim status slot - status bar is created by initThreeScene, appended here. */
const SimStatusSlot = React.memo(React.forwardRef<HTMLDivElement>(function SimStatusSlot(_props, ref) {
  return <div ref={ref} />;
}));

/** Imperative debug panel slot - performance stats created by initThreeScene. */
const DebugPanelSlot = React.memo(React.forwardRef<HTMLDivElement>(function DebugPanelSlot(_props, ref) {
  return <div ref={ref} style={{ position: 'absolute', bottom: 0, left: 0 }} />;
}));

type SlotType = 'graveyard' | 'buy' | 'deploy' | 'connecting' | 'dead' | 'active';

/** Current flies tab slots. Uses slot-type selector so we only re-render when slot states change, not every sim tick. */
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
  latestFliesRef,
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
  latestFliesRef: React.MutableRefObject<FlyState[]>;
}) {
  const slotTypes = useSimDisplayDataSelector(
    useCallback(
      (data: { flies: FlyState[] }) => {
        const flies = data.flies;
        const types: { slot0: SlotType; slot1: SlotType; slot2: SlotType } = { slot0: 'buy', slot1: 'buy', slot2: 'buy' };
        for (let i = 0; i < 3; i++) {
          const inGraveyard = graveyardSlots.has(i);
          const hasFly = myFlies[i] != null;
          const simIdx = deployed[i];
          const isDeployed = simIdx != null;
          const hasSimFly = isDeployed && flies[simIdx] != null;
          const simFly = hasSimFly ? flies[simIdx]! : DEFAULT_FLY;
          const isDead = hasSimFly && simFly.dead;
          const t: SlotType = inGraveyard
            ? 'graveyard'
            : !hasFly
              ? 'buy'
              : !isDeployed
                ? 'deploy'
                : isDeployed && !hasSimFly
                  ? 'connecting'
                  : isDead
                    ? 'dead'
                    : 'active';
          (types as Record<string, SlotType>)[`slot${i}`] = t;
        }
        return types;
      },
      [graveyardSlots, myFlies, deployed]
    )
  );

  return (
    <>
      <div className="fly-viewer__current-title">Current Flies</div>
      {[0, 1, 2].map((i) => {
        const slotType = (slotTypes as Record<string, SlotType>)[`slot${i}`];
        const isEmpty = myFlies.length === 0 && i === 0;
        return (
          <div key={i} className="fly-viewer__fly-slot">
            {slotType === 'graveyard' ? (
              <FlySlotGraveyard index={i} />
            ) : slotType === 'buy' ? (
              <FlySlotBuy index={i} isEmpty={isEmpty} setBuyFlySlot={setBuyFlySlot} />
            ) : slotType === 'deploy' ? (
              <FlySlotDeploy index={i} deployFly={deployFly} setError={setError} />
            ) : slotType === 'connecting' ? (
              <FlySlotConnecting index={i} />
            ) : slotType === 'dead' ? (
              <FlySlotDead
                index={i}
                statsBySlot={statsBySlot}
                address={address}
                graveyardSlots={graveyardSlots}
                deployed={deployed}
                selectedFlyIndex={selectedFlyIndex}
                onSelectSlot={onSelectSlot}
                setGraveyardByWallet={setGraveyardByWallet}
                latestFliesRef={latestFliesRef}
              />
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

/** Graveyard tab slots: 3 slots showing in-graveyard or empty. */
function FliesPanelGraveyardSlots({
  graveyardSlots,
  statsBySlot,
  rewardPerPointWei,
}: {
  graveyardSlots: Set<number>;
  statsBySlot: Record<number, number>;
  rewardPerPointWei: string | undefined;
}) {
  return (
    <>
      <div className="fly-viewer__graveyard-title">NeuroFly Graveyard</div>
      {[0, 1, 2].map((i) => {
        const inGraveyard = graveyardSlots.has(i);
        const pts = statsBySlot[i] ?? 0;
        const wei = rewardPerPointWei ? BigInt(rewardPerPointWei) * BigInt(pts) : 0n;
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
  );
}

export default function FlyViewer() {
  const { address } = usePrivyWallet();
  const queryClient = useQueryClient();
  const [selectedFlyIndex, setSelectedFlyIndex] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const cameraToggleSlotRef = useRef<HTMLDivElement>(null);
  const simStatusSlotRef = useRef<HTMLDivElement>(null);
  const debugPanelSlotRef = useRef<HTMLDivElement>(null);
  const updateCameraButtonRef = useRef<((mode: CameraMode) => void) | null>(null);
  const deployedRef = useRef<Record<number, number>>({});
  const selectedFlyIndexRef = useRef(0);
  const connectedRef = useRef(false);
  const followSimIndexRef = useRef<number | undefined>(undefined);
  const sourcesRef = useRef<WorldSource[]>([]);
  const flyCardDataRef = useRef<Map<number, { fly: FlyState; points: number }>>(new Map());

  const { data: worldData, isError: worldError } = useQuery({
    queryKey: apiKeys.world(),
    queryFn: fetchWorld,
  });
  const sources = worldData?.sources ?? [];

  const { data: neuronsData, isError: neuronsError } = useQuery({
    queryKey: apiKeys.neurons(),
    queryFn: fetchNeurons,
  });
  const neuronLabels = useMemo(() => {
    const list = neuronsData?.neurons ?? [];
    const labels: Record<string, string> = {};
    for (const n of list as NeuronRaw[]) {
      const full = [n.cell_type, n.role].filter(Boolean).join(' ') || n.root_id;
      labels[n.root_id] = full;
    }
    return labels;
  }, [neuronsData?.neurons]);

  useEffect(() => {
    if (worldError) setError((prev) => prev ?? 'Failed to load world');
    else if (neuronsError) setError((prev) => prev ?? 'Failed to load neurons');
    else setError((prev) => (prev === 'Failed to load world' || prev === 'Failed to load neurons' ? null : prev));
  }, [worldError, neuronsError]);

  const { data: myFlies = [] } = useQuery({
    queryKey: apiKeys.myFlies(address ?? '__unauthenticated__'),
    queryFn: () => fetchMyFlies(address!),
    enabled: !!address,
  });

  const { data: deployed = {}, refetch: refetchDeployed } = useQuery({
    queryKey: apiKeys.myDeployed(address ?? '__unauthenticated__'),
    queryFn: () => fetchMyDeployed(address!),
    enabled: !!address,
  });

  const { data: rewardsHistory } = useQuery({
    queryKey: apiKeys.rewardsHistory(),
    queryFn: async () => {
      const r = await fetch(getApiBase() + '/api/rewards/history?limit=50');
      if (!r.ok) throw new Error('Failed to fetch');
      const j = await r.json();
      return (j.history ?? []) as { address: string; amountWei: string; timestamp: string; txHash?: string }[];
    },
    refetchInterval: connected ? 15_000 : false,
  });

  const rewardsHistoryForTable = useMemo(
    () => rewardsHistory ?? [],
    [rewardsHistory]
  );

  const { data: flyStatsData } = useQuery({
    queryKey: apiKeys.flyStats(address ?? '__unauthenticated__'),
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
    const unsub = subscribeSim((event) => {
      if ('_event' in event) {
        if (event._event === 'open') {
          setConnected(true);
          setError(null);
          /* preserve replay state: do not clear snapshotBufferRef, latestFliesRef, activityRef, activitiesRef */
        } else if (event._event === 'closed') {
          setConnected(false);
        }
        /* omit websocket 'error' - sim status already shows "Connecting…" and transient errors are misleading */
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
      /* omit data.error - sim status shows connection state; transient errors are misleading */
      if (data.sources && Array.isArray(data.sources) && !(Array.isArray(data.frames) && data.frames.length > 0)) {
        queryClient.setQueryData(apiKeys.world(), { sources: data.sources });
      }
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
              sources: f.sources,
            });
          }
          const maxT = buf[buf.length - 1]?.t ?? 0;
          while (buf.length > 1 && (buf[0]?.t ?? 0) < maxT - 1) buf.shift();
          while (buf.length > MAX_SNAPSHOT_BUFFER) buf.shift();
        } else {
          const fliesArr = Array.isArray(data.flies) ? data.flies : data.fly ? [data.fly] : null;
          if (fliesArr) {
            const newT = data.t ?? 0;
            if (newT < lastT) buf.length = 0;
            buf.push({
              t: newT,
              flies: fliesArr,
            });
            const maxT = buf[buf.length - 1]?.t ?? 0;
            while (buf.length > 1 && (buf[0]?.t ?? 0) < maxT - 1) buf.shift();
            while (buf.length > MAX_SNAPSHOT_BUFFER) buf.shift();
          }
        }
        const last = buf[buf.length - 1];
        if (Array.isArray(data.frames) && data.frames.length > 0) {
          const lastFrame = data.frames[data.frames.length - 1]!;
          latestFliesRef.current = lastFrame.flies;
          activityRef.current = lastFrame.activity ?? lastFrame.activities?.[0] ?? {};
          activitiesRef.current = lastFrame.activities ?? [];
        } else if (last) {
          latestFliesRef.current = last.flies;
          activityRef.current = data.activity ?? data.activities?.[0] ?? {};
          activitiesRef.current = Array.isArray(data.activities) ? data.activities : [];
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
  }, [queryClient]);

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
    sourcesRef.current = sources;
  }, [sources]);

  useEffect(() => {
    deployedRef.current = deployed;
    selectedFlyIndexRef.current = selectedFlyIndex;
    connectedRef.current = connected;
  }, [deployed, selectedFlyIndex, connected]);

  useEffect(() => {
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:0';
    document.body.insertBefore(container, document.body.firstChild);

    const simStatusRefs: SimStatusRefs = {
      latestFliesRef,
      activityRef,
      activitiesRef,
      deployedRef,
      selectedFlyIndexRef,
      connectedRef,
    };
    const { dispose, updateButton } = initThreeScene(
      container,
      {
        latestFliesRef,
        interpolatedBySimRef,
        debugStatsRef,
        cameraModeRef,
        followSimIndexRef,
        sourcesRef,
        snapshotBufferRef,
        targetRef: cameraTargetRef,
      },
      cameraToggleSlotRef.current,
      simStatusSlotRef.current,
      simStatusRefs,
      debugPanelSlotRef.current
    );
    updateCameraButtonRef.current = updateButton;
    return () => {
      updateCameraButtonRef.current = null;
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

  const setDeployError = useCallback<React.Dispatch<React.SetStateAction<string | null>>>((value) => {
    setError((prev) => {
      const next = typeof value === 'function' ? value(prev) : value;
      if (next === null) return typeof prev === 'string' && prev.startsWith('Deploy failed') ? null : prev;
      return next.startsWith('Deploy failed') ? next : prev;
    });
  }, []);

  const deployFly = useCallback(
    async (slotIndex: number) => {
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
      queryClient.invalidateQueries({ queryKey: apiKeys.myDeployed(address!) });
      queryClient.invalidateQueries({ queryKey: apiKeys.flyStats(address!) });
      refetchDeployed();
    },
    [address, queryClient, refetchDeployed]
  );

  return (
    <SimRefsProvider value={simRefs}>
      <SimStateSync
        deployed={deployed}
        deployedSlotKeys={deployedSlotKeys}
        selectedFlyIndex={selectedFlyIndex}
        setSelectedFlyIndex={setSelectedFlyIndex}
        cameraModeRef={cameraModeRef}
        updateCameraButtonRef={updateCameraButtonRef}
        cameraTargetRef={cameraTargetRef}
        followSimIndexRef={followSimIndexRef}
      />
      <div style={{ width: '100vw', height: '100vh', position: 'relative', pointerEvents: 'none' }}>
        {/* Canvas lives outside React (appended to body in useEffect) - no React re-renders */}
        {/* UI layer - always on top, always visible */}
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'none' }}>
          {/* <DebugOverlay debugStatsRef={debugStatsRef} connected={connected} /> */}
          {error && (
            <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', background: '#333', color: '#f88', padding: '8px 16px', borderRadius: 8, pointerEvents: 'auto' }}>
              {error}
            </div>
          )}
          <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, pointerEvents: 'auto' }}>
            <ConnectButton />
            <CameraToggleSlot
              ref={cameraToggleSlotRef}
              deployed={deployed}
              selectedFlyIndex={selectedFlyIndex}
            />
            <SimStatusSlot ref={simStatusSlotRef} />
          </div>
          <div style={{ position: 'absolute', bottom: 12, left: 56, pointerEvents: 'auto' }}>
            <DebugPanelSlot ref={debugPanelSlotRef} />
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
                setError={setDeployError}
                deployFly={deployFly}
                setBuyFlySlot={setBuyFlySlot}
                getFlyCardData={getFlyCardData}
                latestFliesRef={latestFliesRef}
              />
            ) : (
              <FliesPanelGraveyardSlots
                graveyardSlots={graveyardSlots}
                statsBySlot={statsBySlot}
                rewardPerPointWei={flyStatsData?.rewardPerPointWei}
              />
            )}
          </div>
        </div>
        {buyFlySlot != null && (
          <BuyFlyModal
            isOpen={true}
            onClose={() => setBuyFlySlot(null)}
            slotIndex={buyFlySlot}
            onSuccess={() => {
              if (address) queryClient.invalidateQueries({ queryKey: apiKeys.myFlies(address) });
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
              {statusPanelOpen && (
                statusTab === 'status' ? (
                  <StatusPanelStatusContent
                    deployed={deployed}
                    selectedFlyIndex={selectedFlyIndex}
                    neuronLabels={neuronLabels}
                  />
                ) : (
                  <RewardsTable history={rewardsHistoryForTable} />
                )
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
                {brainPanelOpen && (
                  <BrainOverlay
                    followSimIndexRef={followSimIndexRef}
                    visible={connected}
                    neurons={neuronsData?.neurons}
                    embedded
                  />
                )}
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
