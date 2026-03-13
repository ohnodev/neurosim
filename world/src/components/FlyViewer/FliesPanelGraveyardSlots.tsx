import { formatEth } from '../../lib/utils';

export function FliesPanelGraveyardSlots({
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
