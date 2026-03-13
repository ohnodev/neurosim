import React, { useCallback } from 'react';
import type { FlyState } from '../../lib/simWsClient';
import { useSimDisplayDataSelector } from '../../lib/simDisplayContext';
import { DEFAULT_FLY } from '../../lib/flyViewerUtils';
import type { ClaimedFly } from '../../lib/api';
import {
  FlySlotBuy,
  FlySlotConnecting,
  FlySlotDead,
  FlySlotDeploy,
  FlySlotGraveyard,
  FlyStatusCardMemo,
} from './FlySlots';

type SlotType = 'graveyard' | 'buy' | 'deploy' | 'connecting' | 'dead' | 'active';

export function FliesPanelCurrentSlots(props: {
  deployed: Record<number, number>;
  selectedFlyIndex: number;
  myFlies: Array<ClaimedFly | null>;
  graveyardSlots: Set<number>;
  statsBySlot: Record<number, number>;
  address: string | undefined;
  onSelectSlot: (slot: number) => void;
  setGraveyardByWallet: React.Dispatch<React.SetStateAction<Record<string, Set<number>>>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  deployFly: (slotIndex: number) => Promise<void>;
  sendToGraveyard: (slotIndex: number) => Promise<void>;
  setBuyFlySlot: (v: number | null) => void;
  getFlyCardData: (slotIndex: number) => { fly: FlyState; points: number };
  subscribeFlyCardTick: (fn: () => void) => () => void;
  latestFliesRef: React.MutableRefObject<FlyState[]>;
}) {
  const {
    deployed,
    selectedFlyIndex,
    myFlies,
    graveyardSlots,
    statsBySlot,
    address,
    onSelectSlot,
    setGraveyardByWallet,
    setError,
    deployFly,
    sendToGraveyard,
    setBuyFlySlot,
    getFlyCardData,
    subscribeFlyCardTick,
    latestFliesRef,
  } = props;

  const slotTypes = useSimDisplayDataSelector(
    useCallback(
      (data: { flies: FlyState[] }) => {
        const flies = data.flies;
        const types: Record<string, SlotType> = { slot0: 'buy', slot1: 'buy', slot2: 'buy' };
        for (let i = 0; i < 3; i++) {
          const inGraveyard = graveyardSlots.has(i);
          const hasFly = myFlies[i] != null;
          const simIdx = deployed[i];
          const isDeployed = simIdx != null;
          const hasSimFly = isDeployed && flies[simIdx] != null;
          const simFly = hasSimFly ? flies[simIdx]! : DEFAULT_FLY;
          const isDead = hasSimFly && simFly.dead;
          const t: SlotType = inGraveyard ? 'graveyard' : !hasFly ? 'buy' : !isDeployed ? 'deploy' : isDeployed && !hasSimFly ? 'connecting' : isDead ? 'dead' : 'active';
          types[`slot${i}`] = t;
        }
        return types;
      },
      [graveyardSlots, myFlies, deployed]
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
        return <FlySlotDeploy index={i} deployFly={deployFly} setError={setError} />;
      case 'connecting':
        return <FlySlotConnecting index={i} />;
      case 'dead':
        return (
          <FlySlotDead
            index={i}
            statsBySlot={statsBySlot}
            address={address}
            graveyardSlots={graveyardSlots}
            deployed={deployed}
            selectedFlyIndex={selectedFlyIndex}
            onSelectSlot={onSelectSlot}
            setGraveyardByWallet={setGraveyardByWallet}
            setError={setError}
            sendToGraveyard={sendToGraveyard}
            latestFliesRef={latestFliesRef}
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
