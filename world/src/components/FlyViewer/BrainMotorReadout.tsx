import { useEffect, useState, type MutableRefObject } from 'react';

export function BrainMotorReadout({
  motorReadoutRef,
}: {
  motorReadoutRef: MutableRefObject<{ left: number; right: number; fwd: number }>;
}) {
  const [motor, setMotor] = useState<{ left: number; right: number; fwd: number }>(motorReadoutRef.current);

  useEffect(() => {
    const id = setInterval(() => {
      const next = motorReadoutRef.current;
      setMotor((prev) =>
        prev.left === next.left && prev.right === next.right && prev.fwd === next.fwd ? prev : next
      );
    }, 200);
    return () => clearInterval(id);
  }, [motorReadoutRef]);

  const leftCount = Math.max(0, Math.round(motor.left / 0.002));
  const rightCount = Math.max(0, Math.round(motor.right / 0.002));
  const diff = rightCount - leftCount;

  return (
    <div style={{ marginTop: 8, fontSize: 12, color: '#9ab' }}>
      <div style={{ color: '#7f8a95', marginBottom: 4 }}>Motor readout (fired this step)</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <span>L {leftCount}</span>
        <span>R {rightCount}</span>
        <span>R-L {diff >= 0 ? `+${diff}` : diff}</span>
      </div>
    </div>
  );
}
