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
    }, 200);
    return () => clearInterval(id);
  }, [motorReadoutRef]);

  const leftCount = Math.max(0, Math.round(motor.leftCount));
  const rightCount = Math.max(0, Math.round(motor.rightCount));
  const diff = rightCount - leftCount;
  const leftMagnitude = Math.max(0, motor.leftMagnitude);
  const rightMagnitude = Math.max(0, motor.rightMagnitude);

  return (
    <div style={{ marginTop: 8, fontSize: 12, color: '#9ab' }}>
      <div style={{ color: '#7f8a95', marginBottom: 4 }}>Motor readout (this step)</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <span>L count {leftCount}</span>
        <span>R count {rightCount}</span>
        <span>R-L {diff >= 0 ? `+${diff}` : diff}</span>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
        <span>L mag {leftMagnitude.toFixed(2)}</span>
        <span>R mag {rightMagnitude.toFixed(2)}</span>
      </div>
    </div>
  );
}
