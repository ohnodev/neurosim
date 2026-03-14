import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorldSource } from '../../../../api/src/world';
import { subscribeSim, sendViewFlyIndex, type FlyState } from '../../lib/simWsClient';
import { type Snapshot, MAX_SNAPSHOT_BUFFER, trimSnapshotBuffer } from '../../lib/flyInterpolation';
import { getApiBase } from '../../lib/constants';
import {
  apiKeys,
  fetchWorld,
  fetchNeurons,
  fetchMyFlies,
  fetchMyDeployed,
  fetchFlyStats,
  fetchGraveyard,
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
import { DEFAULT_FLY, flyCardDataEqual, resolveEffectiveSimIndex } from '../../lib/flyViewerUtils';
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
  const [graveyardPage, setGraveyardPage] = useState(1);
  const [statusPanelOpen, setStatusPanelOpen] = useState(() => !isMobileViewport());
  const [statusTab, setStatusTab] = useState<'status' | 'rewards'>('status');
  const [brainPanelOpen, setBrainPanelOpen] = useState(() => !isMobileViewport());
  const [deployingSlots, setDeployingSlots] = useState<Set<number>>(new Set());
  const deployingSlotsRef = useRef<Set<number>>(new Set());

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
  const prevWsFlyCountRef = useRef(0);

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

  const { data: myDeployedData = { deployed: {}, graveyardSlots: [] }, refetch: refetchDeployed } = useQuery({
    queryKey: apiKeys.myDeployed(address ?? '__unauthenticated__'),
    queryFn: () => fetchMyDeployed(address!),
    enabled: !!address,
  });
  const deployed = myDeployedData.deployed;

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
  const graveyardSlots = useMemo(() => {
    return new Set(myDeployedData.graveyardSlots);
  }, [myDeployedData.graveyardSlots]);

  const { data: graveyardData } = useQuery({
    queryKey: apiKeys.graveyard(address ?? '__unauthenticated__', graveyardPage),
    queryFn: () => fetchGraveyard(address!, graveyardPage, 3),
    enabled: !!address && fliesTab === 'graveyard',
  });

  useEffect(() => {
    const unsub = subscribeSim((event) => {
      if ('_event' in event) {
        if (event._event === 'open') {
          setConnected(true);
          setError((prev) =>
            prev && /socket|connection|websocket|connect|closed/i.test(prev) ? null : prev
          );
          const currentDeployed = deployedRef.current;
          const currentSelectedSlot = selectedFlyIndexRef.current;
          const currentSlotKeys = Object.keys(currentDeployed)
            .map((k) => parseInt(k, 10))
            .filter((n) => !Number.isNaN(n) && currentDeployed[n] != null)
            .sort((a, b) => a - b);
          const eff = resolveEffectiveSimIndex(
            latestFliesRef.current,
            currentDeployed,
            currentSelectedSlot,
            currentSlotKeys,
          );
          prevWsFlyCountRef.current = Math.max(
            currentSlotKeys.length,
            latestFliesRef.current.length,
          );
          sendViewFlyIndex(eff ?? 0);
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
      if (data.sources && Array.isArray(data.sources)) {
        queryClient.setQueryData(apiKeys.world(), { sources: data.sources });
      }
      if (!data.error) {
        const buf = snapshotBufferRef.current;
        const batchSources = Array.isArray(data.sources) ? data.sources : [];
        const lastT = buf.length > 0 ? (buf[buf.length - 1]?.t ?? 0) : -Infinity;
        if (Array.isArray(data.frames) && data.frames.length > 0) {
          const firstNewT = data.frames[0]?.t ?? 0;
          if (firstNewT < lastT) buf.length = 0;
          for (const f of data.frames) buf.push({ t: f.t, flies: f.flies, sources: batchSources });
          trimSnapshotBuffer(buf, MAX_SNAPSHOT_BUFFER);
        } else {
          const fliesArr = Array.isArray(data.flies) ? data.flies : data.fly ? [data.fly] : null;
          if (fliesArr) {
            const newT = data.t ?? 0;
            if (newT < lastT) buf.length = 0;
            buf.push({ t: newT, flies: fliesArr, sources: batchSources });
            trimSnapshotBuffer(buf, MAX_SNAPSHOT_BUFFER);
          }
        }
        const last = buf[buf.length - 1];
        if (Array.isArray(data.frames) && data.frames.length > 0) {
          const lastFrame = data.frames[data.frames.length - 1]!;
          latestFliesRef.current = lastFrame.flies;
          activityRef.current = data.activity ?? {};
          activitiesRef.current = [];
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
        else if (Array.isArray(data.activities) && data.activities.length > 0 && data.activities[0] != null) {
          // Use incoming data.activities when data.activity is absent (legacy payload)
          activityRef.current = data.activities[0] ?? {};
        }
        const currentFlyCount = latestFliesRef.current.length;
        if (address && currentFlyCount < prevWsFlyCountRef.current) {
          queryClient.invalidateQueries({ queryKey: apiKeys.myFlies(address) });
          queryClient.invalidateQueries({ queryKey: apiKeys.myDeployed(address) });
          queryClient.invalidateQueries({ queryKey: apiKeys.flyStats(address) });
          queryClient.invalidateQueries({ queryKey: apiKeys.graveyard(address) });
          void refetchDeployed();
        }
        prevWsFlyCountRef.current = currentFlyCount;
      }
    });
    return unsub;
  }, [address, queryClient, refetchDeployed]);

  const flyCardTickListenersRef = useRef<Set<() => void>>(new Set());
  const subscribeFlyCardTick = useCallback((fn: () => void) => {
    flyCardTickListenersRef.current.add(fn);
    return () => {
      flyCardTickListenersRef.current.delete(fn);
    };
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
        if (!prev || !flyCardDataEqual(prev, next)) flyCardDataRef.current.set(i, next);
      }
      flyCardTickListenersRef.current.forEach((fn) => fn());
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
  const onStatusPanelToggle = useCallback(() => setStatusPanelOpen((o) => !o), []);
  const onBrainPanelToggle = useCallback(() => setBrainPanelOpen((o) => !o), []);

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
    deployingSlotsRef.current = deployingSlots;
  }, [deployingSlots]);

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

  const deployMutation = useMutation({
    mutationFn: async (slotIndex: number): Promise<{ simIndex?: number }> => {
      if (!address) throw new Error('Wallet not connected');
      const r = await fetch(`${getApiBase()}/api/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address.toLowerCase(), slotIndex }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? 'Deploy failed');
      return data as { simIndex?: number };
    },
    onMutate: () => {
      setError((prev) => (prev && prev.startsWith('Deploy failed') ? null : prev));
    },
    onSuccess: (data, slotIndex) => {
      if (!address) return;
      if (typeof data.simIndex === 'number') {
        queryClient.setQueryData(apiKeys.myDeployed(address), (current: unknown) => {
          if (current && typeof current === 'object') {
            const c = current as { deployed?: Record<number, number>; graveyardSlots?: number[] };
            return {
              ...c,
              deployed: { ...(c.deployed ?? {}), [slotIndex]: data.simIndex! },
              graveyardSlots: c.graveyardSlots ?? [],
            };
          }
          return { deployed: { [slotIndex]: data.simIndex! }, graveyardSlots: [] };
        });
      } else {
        queryClient.invalidateQueries({ queryKey: apiKeys.myDeployed(address) });
      }
      queryClient.invalidateQueries({ queryKey: apiKeys.flyStats(address) });
      void refetchDeployed();
    },
    onError: (err) => {
      setError(err instanceof Error ? `Deploy failed: ${err.message}` : 'Deploy failed');
    },
    onSettled: (_, __, slotIndex) => {
      const next = new Set(deployingSlotsRef.current);
      next.delete(slotIndex);
      deployingSlotsRef.current = next;
      setDeployingSlots(next);
    },
  });

  const deployFly = useCallback(
    (slotIndex: number) => {
      const inFlight = deployingSlotsRef.current;
      if (inFlight.has(slotIndex)) return;
      const next = new Set(inFlight);
      next.add(slotIndex);
      deployingSlotsRef.current = next;
      setDeployingSlots(next);
      void deployMutation.mutate(slotIndex);
    },
    [deployMutation]
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
                  onClick={() => {
                    setFliesTab('current');
                    setGraveyardPage(1);
                  }}
                >
                  <img src="/fly.svg" alt="" width={14} height={14} className="fly-viewer__tab-icon" aria-hidden />
                  Current
                </button>
                <button
                  type="button"
                  className={`fly-viewer__flies-tab ${fliesTab === 'graveyard' ? 'fly-viewer__flies-tab--active' : ''}`}
                  onClick={() => {
                    setFliesTab('graveyard');
                    setGraveyardPage(1);
                  }}
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
                  deployingSlots={deployingSlots}
                  statsBySlot={statsBySlot}
                  onSelectSlot={onSelectFlySlot}
                  deployFly={deployFly}
                  setBuyFlySlot={setBuyFlySlot}
                  getFlyCardData={getFlyCardData}
                  subscribeFlyCardTick={subscribeFlyCardTick}
                />
              ) : (
                <FliesPanelGraveyardSlots
                  entries={graveyardData?.items ?? []}
                  page={graveyardData?.page ?? graveyardPage}
                  totalPages={graveyardData?.totalPages ?? 1}
                  total={graveyardData?.total ?? 0}
                  onPageChange={setGraveyardPage}
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
          <SidePanelToggle open={statusPanelOpen} onToggle={onStatusPanelToggle} label="Status" position="left" />
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
          <SidePanelToggle open={brainPanelOpen} onToggle={onBrainPanelToggle} label="Brain" position="right" />
        </div>
      </div>
    </SimRefsProvider>
  );
}
