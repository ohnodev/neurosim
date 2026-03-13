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
  myFlies: ClaimedFly[];
  graveyardSlots: Set<number>;
  statsBySlot: Record<number, number>;
  address: string | undefined;
  onSelectSlot: (slot: number) => void;
  setGraveyardByWallet: React.Dispatch<React.SetStateAction<Record<string, Set<number>>>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  deployFly: (slotIndex: number) => Promise<void>;
  setBuyFlySlot: (v: number | null) => void;
  getFlyCardData: (slotIndex: number) => { fly: FlyState; points: number };
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
    setBuyFlySlot,
    getFlyCardData,
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

  return (
    <>
      <div className="fly-viewer__current-title">Current Flies</div>
      {[0, 1, 2].map((i) => {
        const slotType = slotTypes[`slot${i}`];
        const isEmpty = myFlies.length === 0 && i === 0;
        return (
          <div key={i} className="fly-viewer__fly-slot">
            {slotType === 'graveyard' && <FlySlotGraveyard index={i} />}
            {slotType === 'buy' && <FlySlotBuy index={i} isEmpty={isEmpty} setBuyFlySlot={setBuyFlySlot} />}
            {slotType === 'deploy' && <FlySlotDeploy index={i} deployFly={deployFly} setError={setError} />}
            {slotType === 'connecting' && <FlySlotConnecting index={i} />}
            {slotType === 'dead' && (
              <FlySlotDead
                index={i}
                statsBySlot={statsBySlot}
                address={address}
                graveyardSlots={graveyardSlots}
                deployed={deployed}
                selectedFlyIndex={selectedFlyIndex}
                onSelectSlot={onSelectSlot}
                setGraveyardByWallet={setGraveyardByWallet}
                latestFliesRef={latestFliesRef}
              />
            )}
            {slotType === 'active' && (
              <FlyStatusCardMemo
                index={i}
                getFlyData={getFlyCardData}
                selected={i === selectedFlyIndex}
                onSelectSlot={onSelectSlot}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
