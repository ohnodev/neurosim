import React, { useCallback } from 'react';
import type { FlyState } from '../../lib/simWsClient';
import { useSimDisplayDataSelector } from '../../lib/simDisplayContext';
import { resolveEffectiveSimIndex } from '../../lib/flyViewerUtils';

export const CameraToggleSlot = React.memo(
  React.forwardRef<HTMLDivElement, { deployed: Record<number, number>; selectedFlyIndex: number }>(
    function CameraToggleSlot({ deployed, selectedFlyIndex }, ref) {
      const { effectiveSimIndex } = useSimDisplayDataSelector(
        useCallback(
          (data: { flies: FlyState[] }) => ({
            effectiveSimIndex: resolveEffectiveSimIndex(data.flies, deployed, selectedFlyIndex),
          }),
          [deployed, selectedFlyIndex]
        )
      );
      return <div ref={ref} style={{ display: effectiveSimIndex == null ? 'none' : undefined }} />;
    }
  )
);
