/**
 * Context and hook for sim display data. Components that need live flies/activity
 * call useSimDisplayData() and re-render on the hook's interval; FlyViewer stays
 * static and only re-renders on user actions.
 */
import React, { createContext, useContext, useSyncExternalStore } from 'react';
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

function useSimRefs(): SimRefs {
  const ctx = useContext(SimRefsContext);
  if (!ctx) throw new Error('useSimDisplayData must be used within SimRefsProvider');
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

  const subscribe = React.useCallback(
    (onStoreChange: () => void) => {
      const id = setInterval(() => {
        onStoreChange();
      }, UI_UPDATE_INTERVAL_MS);
      return () => clearInterval(id);
    },
    []
  );

  const getSnapshot = React.useCallback(() => {
    return {
      flies: latestFliesRef.current,
      activity: activityRef.current,
      activities: activitiesRef.current,
    };
  }, [latestFliesRef, activityRef, activitiesRef]);

  const getServerSnapshot = getSnapshot;

  const data = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return data;
}
