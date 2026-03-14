import { useCallback } from 'react';
import type { FlyState } from '../../lib/simWsClient';
import { useSimDisplayDataSelector } from '../../lib/simDisplayContext';
import { DEFAULT_FLY } from '../../lib/flyViewerUtils';
import type { ClaimedFly } from '../../lib/api';
import {
  FlySlotBuy,
  FlySlotConnecting,
  FlySlotDead,
  FlySlotDeploy,
  FlySlotDeploying,
  FlySlotGraveyard,
  FlyStatusCardMemo,
} from './FlySlots';

type SlotType = 'graveyard' | 'buy' | 'deploy' | 'deploying' | 'connecting' | 'dead' | 'active';

export function FliesPanelCurrentSlots(props: {
  deployed: Record<number, number>;
  selectedFlyIndex: number;
  myFlies: Array<ClaimedFly | null>;
  graveyardSlots: Set<number>;
  deployingSlots: Set<number>;
  statsBySlot: Record<number, number>;
  onSelectSlot: (slot: number) => void;
  deployFly: (slotIndex: number) => void;
  setBuyFlySlot: (v: number | null) => void;
  getFlyCardData: (slotIndex: number) => { fly: FlyState; points: number };
  subscribeFlyCardTick: (fn: () => void) => () => void;
}) {
  const {
    deployed,
    selectedFlyIndex,
    myFlies,
    graveyardSlots,
    deployingSlots,
    statsBySlot,
    onSelectSlot,
    deployFly,
    setBuyFlySlot,
    getFlyCardData,
    subscribeFlyCardTick,
  } = props;

  const slotTypes = useSimDisplayDataSelector(
    useCallback(
      (data: { flies: FlyState[] }) => {
        const flies = data.flies;
        const types: Record<string, SlotType> = { slot0: 'buy', slot1: 'buy', slot2: 'buy' };
        for (let i = 0; i < 3; i++) {
          const inGraveyard = graveyardSlots.has(i);
          const hasFly = myFlies[i] != null;
          const isDeploying = deployingSlots.has(i);
          const simIdx = deployed[i];
          const isDeployed = simIdx != null;
          const hasSimFly = isDeployed && flies[simIdx] != null;
          const simFly = hasSimFly ? flies[simIdx]! : DEFAULT_FLY;
          const isDead = hasSimFly && simFly.dead;
          const t: SlotType = inGraveyard
            ? 'graveyard'
            : !hasFly
              ? 'buy'
              : isDeploying
                ? 'deploying'
                : !isDeployed
                  ? 'deploy'
                  : isDeployed && !hasSimFly
                    ? 'connecting'
                    : isDead
                      ? 'dead'
                      : 'active';
          types[`slot${i}`] = t;
        }
        return types;
      },
      [graveyardSlots, myFlies, deployingSlots, deployed]
    )
  );

  const renderSlot = (i: number) => {
    const slotType = slotTypes[`slot${i}`];
    const isEmpty = myFlies.every((f) => f == null) && i === 0;
    switch (slotType) {
      case 'graveyard':
        return <FlySlotGraveyard index={i} />;
      case 'buy':
        return <FlySlotBuy index={i} isEmpty={isEmpty} setBuyFlySlot={setBuyFlySlot} />;
      case 'deploy':
        return <FlySlotDeploy index={i} deployFly={deployFly} disabled={deployingSlots.has(i)} />;
      case 'deploying':
        return <FlySlotDeploying index={i} />;
      case 'connecting':
        return <FlySlotConnecting index={i} />;
      case 'dead':
        return (
          <FlySlotDead
            index={i}
            statsBySlot={statsBySlot}
          />
        );
      case 'active':
        return (
          <FlyStatusCardMemo
            index={i}
            getFlyData={getFlyCardData}
            subscribeTick={subscribeFlyCardTick}
            selected={i === selectedFlyIndex}
            onSelectSlot={onSelectSlot}
          />
        );
      default:
        return null;
    }
  };

  return (
    <>
      <div className="fly-viewer__current-title">Current Flies</div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="fly-viewer__fly-slot">
          {renderSlot(i)}
        </div>
      ))}
    </>
  );
}
