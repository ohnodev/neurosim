import React from 'react';

export const SimStatusSlot = React.memo(React.forwardRef<HTMLDivElement>(function SimStatusSlot(_props, ref) {
  return <div ref={ref} />;
}));
