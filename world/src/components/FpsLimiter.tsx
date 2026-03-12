import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

const TARGET_FPS = 30;
const INTERVAL_MS = 1000 / TARGET_FPS;

/** Drives the canvas at 30fps when using frameloop="demand". Call once inside Canvas. */
export function FpsLimiter() {
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    const id = setInterval(invalidate, INTERVAL_MS);
    return () => clearInterval(id);
  }, [invalidate]);

  return null;
}
