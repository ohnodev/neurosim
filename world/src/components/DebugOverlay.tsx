import { useState, useEffect } from 'react';
import { getLastMessageTime } from '../lib/simWsClient';
import type { InterpolationDebugStats } from '../lib/threeScene';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

interface DebugOverlayProps {
  debugStatsRef: React.MutableRefObject<InterpolationDebugStats | null>;
  connected: boolean;
  /** Only render in DEV unless force shown */
  forceShow?: boolean;
}

export function DebugOverlay({ debugStatsRef, connected, forceShow = false }: DebugOverlayProps) {
  const [stats, setStats] = useState<{
    fps: number;
    bufferLen: number;
    tDisplay: number;
    speed: number;
    rangeStart: number;
    rangeEnd: number;
    memoryUsed: number | null;
    memoryTotal: number | null;
    msSinceLastMessage: number | null;
  }>({ fps: 0, bufferLen: 0, tDisplay: 0, speed: 1, rangeStart: 0, rangeEnd: 0, memoryUsed: null, memoryTotal: null, msSinceLastMessage: null });

  useEffect(() => {
    if (!forceShow && import.meta.env?.DEV !== true) return;
    const interval = setInterval(() => {
      const d = debugStatsRef.current;
      const perf = typeof performance !== 'undefined' ? (performance as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory : undefined;
      const lastMsg = getLastMessageTime();
      const msSinceLastMessage = lastMsg > 0 ? Date.now() - lastMsg : null;

      setStats({
        fps: d?.fps ?? 0,
        bufferLen: d?.bufferLen ?? 0,
        tDisplay: d?.tDisplay ?? 0,
        speed: d?.speed ?? 1,
        rangeStart: d?.rangeStart ?? 0,
        rangeEnd: d?.rangeEnd ?? 0,
        memoryUsed: perf?.usedJSHeapSize ?? null,
        memoryTotal: perf?.totalJSHeapSize ?? null,
        msSinceLastMessage,
      });
    }, 200);
    return () => clearInterval(interval);
  }, [debugStatsRef, forceShow]);

  if (!forceShow && import.meta.env?.DEV !== true) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 8,
        left: 8,
        zIndex: 9999,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 10,
        color: '#aaa',
        background: 'rgba(0,0,0,0.75)',
        padding: '6px 10px',
        borderRadius: 4,
        pointerEvents: 'none',
        lineHeight: 1.5,
      }}
    >
      <div style={{ color: '#8af', marginBottom: 4 }}>Debug</div>
      <div>FPS: <span style={{ color: stats.fps >= 55 ? '#4a4' : stats.fps >= 30 ? '#ca0' : '#c44' }}>{stats.fps.toFixed(0)}</span></div>
      <div>Buffer: {stats.bufferLen} frames</div>
      <div>tDisplay: {stats.tDisplay.toFixed(2)}s | speed: {stats.speed.toFixed(3)}</div>
      <div>Range: [{stats.rangeStart.toFixed(2)} .. {stats.rangeEnd.toFixed(2)}]</div>
      <div>WS: {connected ? (stats.msSinceLastMessage != null ? `${stats.msSinceLastMessage}ms ago` : '—') : 'disconnected'}</div>
      {stats.memoryUsed != null && (
        <div>Mem: {formatBytes(stats.memoryUsed)} / {formatBytes(stats.memoryTotal ?? 0)}</div>
      )}
    </div>
  );
}
