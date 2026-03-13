import React, { useEffect, useRef } from 'react';
import type { FlyState } from '../../lib/simWsClient';
import { sendViewFlyIndex } from '../../lib/simWsClient';
import { useSimRefs } from '../../lib/simDisplayContext';
import { DEFAULT_FLY, resolveEffectiveSimIndex } from '../../lib/flyViewerUtils';
import type { CameraMode } from '../../lib/threeScene';

export function SimStateSync({
  deployed,
  deployedSlotKeys,
  selectedFlyIndex,
  setSelectedFlyIndex,
  cameraModeRef,
  updateCameraButtonRef,
  cameraTargetRef,
  followSimIndexRef,
}: {
  deployed: Record<number, number>;
  deployedSlotKeys: number[];
  selectedFlyIndex: number;
  setSelectedFlyIndex: (v: number) => void;
  cameraModeRef: React.MutableRefObject<CameraMode>;
  updateCameraButtonRef: React.MutableRefObject<((mode: CameraMode) => void) | null>;
  cameraTargetRef: React.MutableRefObject<{ x: number; y: number; z: number; heading: number } | null>;
  followSimIndexRef: React.MutableRefObject<number | undefined>;
}) {
  const { latestFliesRef } = useSimRefs();
  const lastSentViewFlyRef = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const flies = latestFliesRef.current;
      const effectiveSimIndex = resolveEffectiveSimIndex(flies, deployed, selectedFlyIndex, deployedSlotKeys);
      const simIndexForSelected = deployed[selectedFlyIndex];

      followSimIndexRef.current = effectiveSimIndex;

      const viewIndex = effectiveSimIndex ?? 0;
      if (lastSentViewFlyRef.current !== viewIndex) {
        lastSentViewFlyRef.current = viewIndex;
        sendViewFlyIndex(viewIndex);
      }

      if (effectiveSimIndex == null && cameraModeRef.current === 'fly') {
        cameraModeRef.current = 'god';
        updateCameraButtonRef.current?.('god');
      }

      if (deployedSlotKeys.length > 0) {
        const valid = simIndexForSelected != null && flies[simIndexForSelected] != null;
        if (!valid) {
          const firstValid = deployedSlotKeys.find(
            (slotIdx) => deployed[slotIdx] != null && flies[deployed[slotIdx]!] != null
          );
          setSelectedFlyIndex(firstValid ?? deployedSlotKeys[0]!);
        }
      }

      if (effectiveSimIndex != null) {
        const focusedFly: FlyState = flies[effectiveSimIndex] ?? DEFAULT_FLY;
        cameraTargetRef.current = {
          x: focusedFly.x ?? 0,
          y: focusedFly.y ?? 0,
          z: focusedFly.z ?? 0,
          heading: focusedFly.heading ?? 0,
        };
      } else {
        cameraTargetRef.current = null;
      }
    }, 200);
    return () => clearInterval(id);
  }, [
    latestFliesRef,
    deployed,
    deployedSlotKeys,
    selectedFlyIndex,
    setSelectedFlyIndex,
    cameraModeRef,
    updateCameraButtonRef,
    cameraTargetRef,
    followSimIndexRef,
  ]);

  return null;
}
