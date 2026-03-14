import React from 'react';
import { formatEth } from '../../lib/utils';
import type { GraveyardFlyEntry } from '../../lib/api';

function FliesPanelGraveyardSlotsInner({
  entries,
  page,
  totalPages,
  total,
  onPageChange,
}: {
  entries: GraveyardFlyEntry[];
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (nextPage: number) => void;
}) {
  return (
    <>
      <div className="fly-viewer__graveyard-title">NeuroFly Graveyard</div>
      {entries.length === 0 ? (
        <div className="fly-viewer__fly-slot fly-viewer__fly-slot--graveyard fly-viewer__fly-slot--graveyard-empty">
          <img src="/tombstone.svg" alt="" width={18} height={18} className="fly-viewer__graveyard-icon" aria-hidden />
          <span className="fly-viewer__fly-slot-label" style={{ color: '#555' }}>No flies in graveyard yet</span>
        </div>
      ) : (
        entries.map((entry, idx) => {
          const pts = entry.feedCount ?? 0;
          const slotLabel = entry.slotIndex + 1;
          let wei = 0n;
          try {
            wei = BigInt(entry.rewardWei ?? '0');
          } catch {
            wei = 0n;
          }
          const ethStr = pts > 0 ? formatEth(wei) : '0';
          const removedLabel = entry.removedAt ? new Date(entry.removedAt).toLocaleString() : 'unknown';
        return (
          <div key={`${entry.flyId}-${idx}`} className="fly-viewer__fly-slot fly-viewer__fly-slot--graveyard">
            <img src="/fly.svg" alt="" width={20} height={20} className="fly-viewer__fly-slot-icon" aria-hidden />
            <img src="/tombstone.svg" alt="" width={18} height={18} className="fly-viewer__graveyard-icon" aria-hidden />
            <div className="fly-viewer__graveyard-fly-info">
              <span className="fly-viewer__fly-slot-label">Fly {slotLabel}</span>
              <span className="fly-viewer__graveyard-stats">{pts} pts · {ethStr} $NEURO</span>
              <span className="fly-viewer__graveyard-time">Removed: {removedLabel}</span>
            </div>
          </div>
        );
        })
      )}
      <div className="fly-viewer__graveyard-pager">
        <button
          type="button"
          className="fly-viewer__graveyard-page-btn"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          Prev
        </button>
        <span className="fly-viewer__graveyard-page-label">
          Page {page} / {Math.max(1, totalPages)} · {total} total
        </span>
        <button
          type="button"
          className="fly-viewer__graveyard-page-btn"
          disabled={page >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        >
          Next
        </button>
      </div>
    </>
  );
}

function graveyardPropsEqual(
  prev: { entries: GraveyardFlyEntry[]; page: number; totalPages: number; total: number; onPageChange: (nextPage: number) => void },
  next: { entries: GraveyardFlyEntry[]; page: number; totalPages: number; total: number; onPageChange: (nextPage: number) => void }
): boolean {
  if (prev.page !== next.page || prev.totalPages !== next.totalPages || prev.total !== next.total) return false;
  if (prev.entries.length !== next.entries.length) return false;
  for (let i = 0; i < prev.entries.length; i++) {
    const a = prev.entries[i];
    const b = next.entries[i];
    if (
      a.flyId !== b.flyId ||
      a.slotIndex !== b.slotIndex ||
      a.feedCount !== b.feedCount ||
      a.rewardWei !== b.rewardWei ||
      a.removedAt !== b.removedAt
    ) {
      return false;
    }
  }
  return true;
}

export const FliesPanelGraveyardSlots = React.memo(FliesPanelGraveyardSlotsInner, graveyardPropsEqual);
