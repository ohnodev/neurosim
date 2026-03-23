import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorldSource } from '../../../../api/src/world';
import { subscribeSim, sendViewFlyIndex, type FlyState, type SimPayload, type WorldTick } from '../../lib/simWsClient';
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
import { HeadingCompass } from '../HeadingCompass';
import {
  computeBumpFromEpgBins,
  computeBumpFromEpgCounts,
  computeBumpFromEpgIndices,
  getEpgCountsInWindow,
} from '../../lib/compassEpgData';
import { SimRefsProvider } from '../../lib/simDisplayContext';
import CompactMenu from '../CompactMenu';
import { BuyFlyModal } from '../BuyFlyModal';
import { initThreeScene, type InterpolationDebugStats, type CameraMode, type SimStatusRefs } from '../../lib/threeScene';
import { usePrivyWallet } from '../../lib/usePrivyWallet';
import { RewardsTable } from '../RewardsTable';
import { StatusPanelStatusContent } from '../StatusPanelStatusContent';
import { DEFAULT_FLY, flyCardDataEqual, resolveEffectiveSimIndex } from '../../lib/flyViewerUtils';
import { isMobileViewport } from '../../lib/mediaQuery';
import { getInitialDevMode } from '../../lib/devMode';
import { CameraToggleSlot } from './CameraToggleSlot';
import { SimStateSync } from './SimStateSync';
import { SimStatusSlot } from './SimStatusSlot';
import { DebugPanelSlot } from './DebugPanelSlot';
import { FliesPanelCurrentSlots } from './FliesPanelCurrentSlots';
import { FliesPanelGraveyardSlots } from './FliesPanelGraveyardSlots';
import { SidePanelToggle } from './SidePanelToggle';
import './FlyViewer.css';

const WEBGL_UNAVAILABLE_ERROR =
  'WebGL is unavailable in this browser context. Enable hardware acceleration or try a normal Chrome window.';

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
  const [brainTab, setBrainTab] = useState<'activity' | 'compass'>('activity');
  const [brainPanelOpen, setBrainPanelOpen] = useState(() => !isMobileViewport());
  const [bumpAngleDeg, setBumpAngleDeg] = useState<number | null>(null);
  const [epgBins, setEpgBins] = useState<number[] | null>(null);
  const [devMode] = useState<boolean>(() => getInitialDevMode());
  const [deployingSlots, setDeployingSlots] = useState<Set<number>>(new Set());
  const deployingSlotsRef = useRef<Set<number>>(new Set());

  const snapshotBufferRef = useRef<Snapshot[]>([]);
  const latestFliesRef = useRef<FlyState[]>([]);
  const activityRef = useRef<Record<string, number>>({});
  const activitiesRef = useRef<(Record<string, number> | undefined)[]>([]);
  const motorReadoutRef = useRef<{
    left: number;
    right: number;
    fwd: number;
    leftCount: number;
    rightCount: number;
    fwdCount: number;
    leftMagnitude: number;
    rightMagnitude: number;
    fwdMagnitude: number;
  }>({
    left: 0,
    right: 0,
    fwd: 0,
    leftCount: 0,
    rightCount: 0,
    fwdCount: 0,
    leftMagnitude: 0,
    rightMagnitude: 0,
    fwdMagnitude: 0,
  });
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
  const devModeRef = useRef(devMode);
  const followSimIndexRef = useRef<number | undefined>(undefined);
  const sourcesRef = useRef<WorldSource[]>([]);
  const flyCardDataRef = useRef<Map<number, { fly: FlyState; points: number }>>(new Map());
  const prevWsFlyCountRef = useRef(0);
  const epgSpikesByFlyRef = useRef<Map<number, import('../../lib/simWsClient').EpgSpikesByNeuronFly>>(new Map());

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

  const myFliesQuery = useQuery({
    queryKey: apiKeys.myFlies(address ?? '__unauthenticated__'),
    queryFn: () => fetchMyFlies(address!),
    enabled: !!address,
  });
  const myFlies = myFliesQuery.data ?? [null, null, null];

  const myDeployedQuery = useQuery({
    queryKey: apiKeys.myDeployed(address ?? '__unauthenticated__'),
    queryFn: () => fetchMyDeployed(address!),
    enabled: !!address,
  });
  const myDeployedData = myDeployedQuery.data ?? { deployed: {}, graveyardSlots: [] };
  const { refetch: refetchDeployed } = myDeployedQuery;
  const deployed = myDeployedData.deployed;
  const ownershipHydrating = !!address && (myFliesQuery.isPending || myDeployedQuery.isPending);

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
          motorReadoutRef.current = {
            left: 0,
            right: 0,
            fwd: 0,
            leftCount: 0,
            rightCount: 0,
            fwdCount: 0,
            leftMagnitude: 0,
            rightMagnitude: 0,
            fwdMagnitude: 0,
          };
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
        motor?: {
          left: number;
          right: number;
          fwd: number;
          leftCount: number;
          rightCount: number;
          fwdCount: number;
          leftMagnitude: number;
          rightMagnitude: number;
          fwdMagnitude: number;
        };
      };
      if (data.sources && Array.isArray(data.sources)) {
        queryClient.setQueryData(apiKeys.world(), { sources: data.sources });
      }
        if (data.motor) {
          motorReadoutRef.current = {
            left: Number.isFinite(data.motor.left) ? data.motor.left : 0,
            right: Number.isFinite(data.motor.right) ? data.motor.right : 0,
            fwd: Number.isFinite(data.motor.fwd) ? data.motor.fwd : 0,
            leftCount: Number.isFinite(data.motor.leftCount) ? data.motor.leftCount : 0,
            rightCount: Number.isFinite(data.motor.rightCount) ? data.motor.rightCount : 0,
            fwdCount: Number.isFinite(data.motor.fwdCount) ? data.motor.fwdCount : 0,
            leftMagnitude: Number.isFinite(data.motor.leftMagnitude) ? data.motor.leftMagnitude : 0,
            rightMagnitude: Number.isFinite(data.motor.rightMagnitude) ? data.motor.rightMagnitude : 0,
            fwdMagnitude: Number.isFinite(data.motor.fwdMagnitude) ? data.motor.fwdMagnitude : 0,
          };
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
          const simIdx = followSimIndexRef.current ?? 0;
          const payload = data as SimPayload;
          const ticks = payload.ticks ?? [];
          const epgIndexToBin = payload.epgIndexToBin ?? [];
          const flyIdBySimIndex = payload.flyIdBySimIndex ?? [];
          const epgSpikesByNeuronByFly = payload.epgSpikesByNeuronByFly ?? [];

          const activeFlyIds = new Set<number>();
          for (const flyId of flyIdBySimIndex) {
            if (typeof flyId === 'number') activeFlyIds.add(flyId);
          }
          for (const batch of epgSpikesByNeuronByFly) {
            activeFlyIds.add(batch.flyId);
          }
          for (const flyId of Array.from(epgSpikesByFlyRef.current.keys())) {
            if (!activeFlyIds.has(flyId)) epgSpikesByFlyRef.current.delete(flyId);
          }

          // Merge per-neuron EPG spikes into running buffer (cap ~5s at 10k ticks/sec)
          const EPG_BUFFER_MAX_TICKS = 50_000;
          for (const batch of epgSpikesByNeuronByFly) {
            const existing = epgSpikesByFlyRef.current.get(batch.flyId);
            const merged: number[][] = existing
              ? batch.spikes.map((arr, i) => {
                  const prev = (existing.spikes[i] ?? []).concat(arr);
                  prev.sort((a, b) => a - b);
                  const minTick = Math.max(0, batch.tickEnd - EPG_BUFFER_MAX_TICKS);
                  const trimmed = prev.filter((t) => t >= minTick);
                  return trimmed;
                })
              : batch.spikes.map((arr) => [...arr].sort((a, b) => a - b));
            epgSpikesByFlyRef.current.set(batch.flyId, {
              flyId: batch.flyId,
              tickStart: existing ? Math.min(existing.tickStart, batch.tickStart) : batch.tickStart,
              tickEnd: batch.tickEnd,
              spikes: merged,
            });
          }

          let deg: number | null = null;
          const derivedBySim: (number | null)[] = [];
          let bins: number[] | null = lastFrame.epgBinsPerSim?.[simIdx] ?? null;
          const viewedFlyId = flyIdBySimIndex[simIdx];
          const viewedEpg = viewedFlyId != null ? epgSpikesByFlyRef.current.get(viewedFlyId) : null;
          let binCounts: number[] | null = null;
          if (viewedEpg && epgIndexToBin.length > 0) {
            const counts = getEpgCountsInWindow(viewedEpg.spikes, viewedEpg.tickEnd, 100);
            binCounts = new Array(16).fill(0);
            for (let idx = 0; idx < counts.length; idx++) {
              const count = counts[idx] ?? 0;
              if (count <= 0) continue;
              const bin = epgIndexToBin[idx];
              if (typeof bin === 'number' && bin >= 0 && bin < 16) binCounts[bin] += count;
            }
            const max = Math.max(...binCounts, 1);
            bins = binCounts.map((c) => c / max);
          }
          // Arrow + 3D fly: use epgBins-based bump (same as Visualization page). Never fall back to fly.heading or Rust bump.
          if (bins && bins.length === 16) {
            const counts = binCounts ?? bins; // use raw counts when available, else bins as proxy
            deg = computeBumpFromEpgBins(bins, counts);
          }
          if (deg == null && ticks.length > 0 && epgIndexToBin.length > 0 && flyIdBySimIndex.length > 0) {
            for (let j = 0; j < flyIdBySimIndex.length; j++) {
              const flyId = flyIdBySimIndex[j];
              const flyData = epgSpikesByFlyRef.current.get(flyId);
              const bump =
                flyData && flyData.spikes.some((s) => s.length > 0)
                  ? computeBumpFromEpgCounts(
                      getEpgCountsInWindow(flyData.spikes, flyData.tickEnd, 100),
                      epgIndexToBin
                    )
                  : (() => {
                      const flyTicks = ticks
                        .filter((t: WorldTick) => t.fly_id === flyId)
                        .sort((a: WorldTick, b: WorldTick) => b.tick - a.tick);
                      const latest = flyTicks[0];
                      return latest ? computeBumpFromEpgIndices(latest.epg, epgIndexToBin) : null;
                    })();
              derivedBySim[j] = bump ?? null;
            }
            deg = derivedBySim[simIdx] ?? null;
          }
          setBumpAngleDeg(deg);
          setEpgBins(Array.isArray(bins) && bins.length === 16 ? bins : null);
        } else if (last) {
          latestFliesRef.current = last.flies;
          activityRef.current = data.activity ?? data.activities?.[0] ?? {};
          activitiesRef.current = Array.isArray(data.activities) ? data.activities : [];
          setBumpAngleDeg(null);
          setEpgBins(null);
        } else if (Array.isArray(data.flies)) {
          latestFliesRef.current = data.flies;
          activityRef.current = data.activity ?? data.activities?.[0] ?? {};
          activitiesRef.current = Array.isArray(data.activities) ? data.activities : [];
          setBumpAngleDeg(null);
          setEpgBins(null);
        } else if (data.fly) {
          latestFliesRef.current = [data.fly];
          activityRef.current = data.activity ?? data.activities?.[0] ?? {};
          activitiesRef.current = Array.isArray(data.activities) ? data.activities : [];
          setBumpAngleDeg(null);
          setEpgBins(null);
        } else {
          setBumpAngleDeg(null);
          setEpgBins(null);
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
      } else {
        setBumpAngleDeg(null);
        setEpgBins(null);
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
    devModeRef.current = devMode;
  }, [deployed, selectedFlyIndex, connected, devMode]);

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
    let dispose = () => {};
    try {
      const initialized = initThreeScene(
        container,
        {
          latestFliesRef,
          interpolatedBySimRef,
          debugStatsRef,
          cameraModeRef,
          followSimIndexRef,
          sourcesRef,
          devModeRef,
          snapshotBufferRef,
          targetRef: cameraTargetRef,
        },
        cameraToggleSlotRef.current,
        simStatusSlotRef.current,
        simStatusRefs,
        debugPanelSlotRef.current
      );
      dispose = initialized.dispose;
      updateCameraButtonRef.current = initialized.updateButton;
    } catch (err) {
      console.error('[FlyViewer] three.js initialization failed', err);
      setError((prev) => prev ?? WEBGL_UNAVAILABLE_ERROR);
    }
    return () => {
      updateCameraButtonRef.current = null;
      dispose();
      container.remove();
    };
  }, []);

  const simRefs = useMemo(
    () => ({ latestFliesRef, activityRef, activitiesRef, epgSpikesByFlyRef }),
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
            <CompactMenu />
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
                  ownershipHydrating={ownershipHydrating}
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
              if (!address) return;
              queryClient.invalidateQueries({ queryKey: apiKeys.myFlies(address) });
              queryClient.invalidateQueries({ queryKey: apiKeys.myDeployed(address) });
              queryClient.invalidateQueries({ queryKey: apiKeys.flyStats(address) });
              queryClient.invalidateQueries({ queryKey: apiKeys.graveyard(address) });
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <button
                  type="button"
                  className={`fly-viewer__status-tab ${brainTab === 'activity' ? 'fly-viewer__status-tab--active' : ''}`}
                  onClick={() => setBrainTab('activity')}
                  style={{ padding: '4px 8px', fontSize: 11 }}
                >
                  Brain Activity
                </button>
                <button
                  type="button"
                  className={`fly-viewer__status-tab ${brainTab === 'compass' ? 'fly-viewer__status-tab--active' : ''}`}
                  onClick={() => setBrainTab('compass')}
                  style={{ padding: '4px 8px', fontSize: 11 }}
                >
                  Heading compass
                </button>
                <div style={{ color: '#888', fontSize: 11, marginLeft: 'auto' }}>Fly {selectedFlyIndex + 1} viewing</div>
              </div>
              {brainTab === 'activity' && (
                <>
                  <div className="fly-viewer__brain-plot">
                    {brainPanelOpen && (
                      <BrainOverlay
                        followSimIndexRef={followSimIndexRef}
                        visible={connected}
                        neurons={neuronsData?.neurons}
                        title={`Fly ${selectedFlyIndex + 1} viewing`}
                        embedded
                      />
                    )}
                  </div>
                </>
              )}
              {brainTab === 'compass' && brainPanelOpen && (
                <div className="fly-viewer__brain-plot">
                  <HeadingCompass bumpAngleDeg={bumpAngleDeg} epgBins={epgBins ?? undefined} />
                </div>
              )}
            </div>
          </div>
          <SidePanelToggle open={brainPanelOpen} onToggle={onBrainPanelToggle} label="Brain" position="right" />
        </div>
      </div>
    </SimRefsProvider>
  );
}
