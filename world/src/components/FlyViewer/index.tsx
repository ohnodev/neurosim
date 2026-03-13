import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorldSource } from '../../../../api/src/world';
import { subscribeSim, type FlyState } from '../../lib/simWsClient';
import { type Snapshot, MAX_SNAPSHOT_BUFFER, trimSnapshotBuffer } from '../../lib/flyInterpolation';
import { getApiBase } from '../../lib/constants';
import {
  apiKeys,
  fetchWorld,
  fetchNeurons,
  fetchMyFlies,
  fetchMyDeployed,
  fetchFlyStats,
  type NeuronRaw,
} from '../../lib/api';
import { BrainOverlay } from '../BrainOverlay';
import { SimRefsProvider } from '../../lib/simDisplayContext';
import { ConnectButton } from '../ConnectButton';
import { BuyFlyModal } from '../BuyFlyModal';
import { initThreeScene, type InterpolationDebugStats, type CameraMode, type SimStatusRefs } from '../../lib/threeScene';
import { usePrivyWallet } from '../../lib/usePrivyWallet';
import { RewardsTable } from '../RewardsTable';
import { StatusPanelStatusContent } from '../StatusPanelStatusContent';
import { DEFAULT_FLY, flyCardDataEqual } from '../../lib/flyViewerUtils';
import { isMobileViewport } from '../../lib/mediaQuery';
import { CameraToggleSlot } from './CameraToggleSlot';
import { SimStateSync } from './SimStateSync';
import { SimStatusSlot } from './SimStatusSlot';
import { DebugPanelSlot } from './DebugPanelSlot';
import { FliesPanelCurrentSlots } from './FliesPanelCurrentSlots';
import { FliesPanelGraveyardSlots } from './FliesPanelGraveyardSlots';
import { SidePanelToggle } from './SidePanelToggle';
import './FlyViewer.css';

export default function FlyViewer() {
  const { address } = usePrivyWallet();
  const queryClient = useQueryClient();
  const [selectedFlyIndex, setSelectedFlyIndex] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fliesPanelOpen, setFliesPanelOpen] = useState(() => !isMobileViewport());
  const [buyFlySlot, setBuyFlySlot] = useState<number | null>(null);
  const [fliesTab, setFliesTab] = useState<'current' | 'graveyard'>('current');
  const [graveyardByWallet, setGraveyardByWallet] = useState<Record<string, Set<number>>>(() => ({}));
  const graveyardSlots = useMemo(
    () => graveyardByWallet[address ?? ''] ?? new Set(),
    [graveyardByWallet, address]
  );
  const [statusPanelOpen, setStatusPanelOpen] = useState(() => !isMobileViewport());
  const [statusTab, setStatusTab] = useState<'status' | 'rewards'>('status');
  const [brainPanelOpen, setBrainPanelOpen] = useState(() => !isMobileViewport());

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

  const rewardsHistoryForTable = useMemo(() => rewardsHistory ?? [], [rewardsHistory]);

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
        } else if (event._event === 'closed') {
          setConnected(false);
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
      if (data.sources && Array.isArray(data.sources) && !(Array.isArray(data.frames) && data.frames.length > 0)) {
        queryClient.setQueryData(apiKeys.world(), { sources: data.sources });
      }
      if (!data.error) {
        const buf = snapshotBufferRef.current;
        const lastT = buf.length > 0 ? (buf[buf.length - 1]?.t ?? 0) : -Infinity;
        if (Array.isArray(data.frames) && data.frames.length > 0) {
          const firstNewT = data.frames[0]?.t ?? 0;
          if (firstNewT < lastT) buf.length = 0;
          for (const f of data.frames) buf.push({ t: f.t, flies: f.flies, sources: f.sources });
          trimSnapshotBuffer(buf, MAX_SNAPSHOT_BUFFER);
        } else {
          const fliesArr = Array.isArray(data.flies) ? data.flies : data.fly ? [data.fly] : null;
          if (fliesArr) {
            const newT = data.t ?? 0;
            if (newT < lastT) buf.length = 0;
            buf.push({ t: newT, flies: fliesArr });
            trimSnapshotBuffer(buf, MAX_SNAPSHOT_BUFFER);
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
        else if (Array.isArray(data.activities) && data.activities[0] != null)
          activityRef.current = data.activities[0] ?? {};
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
        if (!prev || !flyCardDataEqual(prev, next)) flyCardDataRef.current.set(i, next);
      }
    }, 200);
    return () => clearInterval(id);
  }, [deployed, statsBySlot]);

  const deployedSlotKeys = useMemo(
    () =>
      Object.keys(deployed)
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
    () => ({ latestFliesRef, activityRef, activitiesRef }),
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
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'none' }}>
          {error && (
            <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', background: '#333', color: '#f88', padding: '8px 16px', borderRadius: 8, pointerEvents: 'auto' }}>
              {error}
            </div>
          )}
          <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, pointerEvents: 'auto' }}>
            <ConnectButton />
            <CameraToggleSlot ref={cameraToggleSlotRef} deployed={deployed} selectedFlyIndex={selectedFlyIndex} />
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
              {statusPanelOpen &&
                (statusTab === 'status' ? (
                  <StatusPanelStatusContent
                    deployed={deployed}
                    selectedFlyIndex={selectedFlyIndex}
                    neuronLabels={neuronLabels}
                  />
                ) : (
                  <RewardsTable history={rewardsHistoryForTable} />
                ))}
            </div>
          </div>
          <SidePanelToggle open={statusPanelOpen} onToggle={() => setStatusPanelOpen((o) => !o)} label="Status" position="left" />
        </div>
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
          <SidePanelToggle open={brainPanelOpen} onToggle={() => setBrainPanelOpen((o) => !o)} label="Brain" position="right" />
        </div>
      </div>
    </SimRefsProvider>
  );
}
