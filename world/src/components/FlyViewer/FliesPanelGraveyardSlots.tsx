import React from 'react';
import { formatEth } from '../../lib/utils';

function FliesPanelGraveyardSlotsInner({
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
        let wei = 0n;
        if (rewardPerPointWei && pts > 0) {
          try {
            const parsed = BigInt(rewardPerPointWei);
            wei = parsed * BigInt(pts);
          } catch {
            wei = 0n;
          }
        }
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

function graveyardPropsEqual(
  prev: { graveyardSlots: Set<number>; statsBySlot: Record<number, number>; rewardPerPointWei: string | undefined },
  next: { graveyardSlots: Set<number>; statsBySlot: Record<number, number>; rewardPerPointWei: string | undefined }
): boolean {
  if (prev.rewardPerPointWei !== next.rewardPerPointWei) return false;
  if (prev.graveyardSlots !== next.graveyardSlots) {
    if (prev.graveyardSlots.size !== next.graveyardSlots.size) return false;
    for (const i of prev.graveyardSlots) if (!next.graveyardSlots.has(i)) return false;
  }
  const slots = [0, 1, 2];
  for (const i of slots) {
    if ((prev.statsBySlot[i] ?? 0) !== (next.statsBySlot[i] ?? 0)) return false;
  }
  return true;
}

export const FliesPanelGraveyardSlots = React.memo(FliesPanelGraveyardSlotsInner, graveyardPropsEqual);
