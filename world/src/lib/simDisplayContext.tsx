/**
 * Context and hook for sim display data. Components that need live flies/activity
 * call useSimDisplayData() and re-render on the hook's interval; FlyViewer stays
 * static and only re-renders on user actions.
 */
import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import type { FlyState } from './simWsClient';

export interface SimRefs {
  latestFliesRef: React.MutableRefObject<FlyState[]>;
  activityRef: React.MutableRefObject<Record<string, number>>;
  activitiesRef: React.MutableRefObject<(Record<string, number> | undefined)[]>;
}

const SimRefsContext = createContext<SimRefs | null>(null);

export function SimRefsProvider({
  value,
  children,
}: {
  value: SimRefs;
  children: React.ReactNode;
}) {
  return <SimRefsContext.Provider value={value}>{children}</SimRefsContext.Provider>;
}

export function useSimRefs(): SimRefs {
  const ctx = useContext(SimRefsContext);
  if (!ctx) throw new Error('useSimRefs must be used within SimRefsProvider');
  return ctx;
}

const UI_UPDATE_INTERVAL_MS = 200;

/**
 * Subscribe to sim display data at 200ms. Only components that call this hook
 * re-render on the interval; FlyViewer does not.
 */
export function useSimDisplayData(): {
  flies: FlyState[];
  activity: Record<string, number>;
  activities: (Record<string, number> | undefined)[];
} {
  const { latestFliesRef, activityRef, activitiesRef } = useSimRefs();
  const [data, setData] = useState(() => ({
    flies: latestFliesRef.current,
    activity: activityRef.current,
    activities: activitiesRef.current,
  }));

  useEffect(() => {
    const id = setInterval(() => {
      setData({
        flies: latestFliesRef.current,
        activity: activityRef.current,
        activities: activitiesRef.current,
      });
    }, UI_UPDATE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [latestFliesRef, activityRef, activitiesRef]);

  return data;
}

const MIN_THROTTLE_MS = 50;

/**
 * Throttled version - only updates every intervalMs. Use for components
 * that show live data but don't need 5 updates/sec.
 */
export function useSimDisplayDataThrottled(intervalMs: number): {
  flies: FlyState[];
  activity: Record<string, number>;
  activities: (Record<string, number> | undefined)[];
} {
  const safeInterval = Math.max(MIN_THROTTLE_MS, Math.floor(Number(intervalMs) || 0));
  const { latestFliesRef, activityRef, activitiesRef } = useSimRefs();
  const [data, setData] = useState(() => ({
    flies: latestFliesRef.current,
    activity: activityRef.current,
    activities: activitiesRef.current,
  }));

  useEffect(() => {
    const id = setInterval(() => {
      setData({
        flies: latestFliesRef.current,
        activity: activityRef.current,
        activities: activitiesRef.current,
      });
    }, safeInterval);
    return () => clearInterval(id);
  }, [latestFliesRef, activityRef, activitiesRef, safeInterval]);

  return data;
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Subscribe to sim data but only re-render when the selected values change.
 * Use this for components that display a small subset (e.g. TopBar) to avoid
 * re-rendering every 200ms when nothing visible changed.
 */
export function useSimDisplayDataSelector<T extends Record<string, unknown>>(
  selector: (data: {
    flies: FlyState[];
    activity: Record<string, number>;
    activities: (Record<string, number> | undefined)[];
  }) => T
): T {
  const { latestFliesRef, activityRef, activitiesRef } = useSimRefs();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const [data, setData] = useState<T>(() =>
    selectorRef.current({
      flies: latestFliesRef.current,
      activity: activityRef.current,
      activities: activitiesRef.current,
    })
  );

  useEffect(() => {
    const next = selectorRef.current({
      flies: latestFliesRef.current,
      activity: activityRef.current,
      activities: activitiesRef.current,
    });
    setData((prev) => (shallowEqual(prev, next) ? prev : next));
    const id = setInterval(() => {
      const n = selectorRef.current({
        flies: latestFliesRef.current,
        activity: activityRef.current,
        activities: activitiesRef.current,
      });
      setData((prev) => (shallowEqual(prev, n) ? prev : n));
    }, UI_UPDATE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [latestFliesRef, activityRef, activitiesRef, selector]);

  return data;
}
