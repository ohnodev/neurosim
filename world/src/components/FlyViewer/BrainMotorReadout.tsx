import { useEffect, useState, type MutableRefObject } from 'react';

export function BrainMotorReadout({
  motorReadoutRef,
}: {
  motorReadoutRef: MutableRefObject<{
    left: number;
    right: number;
    fwd: number;
    leftCount: number;
    rightCount: number;
    fwdCount: number;
    leftMagnitude: number;
    rightMagnitude: number;
    fwdMagnitude: number;
  }>;
}) {
  const EMA_ALPHA = 0.22;
  const [motor, setMotor] = useState<{
    left: number;
    right: number;
    fwd: number;
    leftCount: number;
    rightCount: number;
    fwdCount: number;
    leftMagnitude: number;
    rightMagnitude: number;
    fwdMagnitude: number;
  }>(motorReadoutRef.current);
  const [ema, setEma] = useState<{ countDiff: number; magDiff: number; scaledDiff: number }>({
    countDiff: 0,
    magDiff: 0,
    scaledDiff: 0,
  });

  useEffect(() => {
    const id = setInterval(() => {
      const next = motorReadoutRef.current;
      setMotor((prev) =>
        prev.left === next.left &&
        prev.right === next.right &&
        prev.fwd === next.fwd &&
        prev.leftCount === next.leftCount &&
        prev.rightCount === next.rightCount &&
        prev.fwdCount === next.fwdCount &&
        prev.leftMagnitude === next.leftMagnitude &&
        prev.rightMagnitude === next.rightMagnitude &&
        prev.fwdMagnitude === next.fwdMagnitude
          ? prev
          : next
      );
      const countDiff = (next.rightCount ?? 0) - (next.leftCount ?? 0);
      const magDiff = (next.rightMagnitude ?? 0) - (next.leftMagnitude ?? 0);
      const scaledDiff = (next.right ?? 0) - (next.left ?? 0);
      setEma((prev) => ({
        countDiff: prev.countDiff + (countDiff - prev.countDiff) * EMA_ALPHA,
        magDiff: prev.magDiff + (magDiff - prev.magDiff) * EMA_ALPHA,
        scaledDiff: prev.scaledDiff + (scaledDiff - prev.scaledDiff) * EMA_ALPHA,
      }));
    }, 200);
    return () => clearInterval(id);
  }, [motorReadoutRef]);

  const leftCount = Math.max(0, Math.round(motor.leftCount));
  const rightCount = Math.max(0, Math.round(motor.rightCount));
  const diff = rightCount - leftCount;
  const leftMagnitude = Math.max(0, motor.leftMagnitude);
  const rightMagnitude = Math.max(0, motor.rightMagnitude);
  const fwdScaled = motor.fwd ?? 0;
  const scaledDiff = (motor.right ?? 0) - (motor.left ?? 0);

  return (
    <div style={{ marginTop: 8, fontSize: 12, color: '#9ab' }}>
      <div style={{ color: '#7f8a95', marginBottom: 4 }}>Motor readout (instant + smoothed)</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <span>L count {leftCount}</span>
        <span>R count {rightCount}</span>
        <span>R-L {diff >= 0 ? `+${diff}` : diff}</span>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
        <span>L mag {leftMagnitude.toFixed(2)}</span>
        <span>R mag {rightMagnitude.toFixed(2)}</span>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
        <span>inst diff {scaledDiff >= 0 ? '+' : ''}{scaledDiff.toFixed(4)}</span>
        <span>F scaled {fwdScaled.toFixed(4)}</span>
        <span>EMA diff {ema.scaledDiff >= 0 ? '+' : ''}{ema.scaledDiff.toFixed(4)}</span>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
        <span>EMA count {ema.countDiff >= 0 ? '+' : ''}{ema.countDiff.toFixed(2)}</span>
        <span>EMA mag {ema.magDiff >= 0 ? '+' : ''}{ema.magDiff.toFixed(2)}</span>
      </div>
    </div>
  );
}
