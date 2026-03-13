import React from 'react';

export const DebugPanelSlot = React.memo(React.forwardRef<HTMLDivElement>(function DebugPanelSlot(_props, ref) {
  return <div ref={ref} style={{ position: 'absolute', bottom: 0, left: 0 }} />;
}));
