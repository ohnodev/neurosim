type PlaybackControlsProps = {
  playing: boolean;
  tick: number;
  totalTicks: number;
  speed: number | 'irl';
  onPlayPause: () => void;
  onPrevTick: () => void;
  onNextTick: () => void;
  onSeekTick: (tick: number) => void;
  onSpeedChange: (speed: number | 'irl') => void;
};

const SPEED_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '0.25', label: '0.25x' },
  { value: '0.5', label: '0.5x' },
  { value: '1', label: '1x' },
  { value: '2', label: '2x' },
  { value: '4', label: '4x' },
  { value: '8', label: '8x' },
  { value: '16', label: '16x' },
  { value: 'irl', label: 'IRL (1s/s)' },
];
const BUTTON_STYLE: Record<string, string | number> = {
  color: '#eef4ff',
  background: '#304d77',
  border: '1px solid #6f8fc0',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

export default function PlaybackControls({
  playing,
  tick,
  totalTicks,
  speed,
  onPlayPause,
  onPrevTick,
  onNextTick,
  onSeekTick,
  onSpeedChange,
}: PlaybackControlsProps) {
  const maxTick = Math.max(1, totalTicks);
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={onPlayPause} style={BUTTON_STYLE}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" onClick={onPrevTick} disabled={tick <= 1} style={{ ...BUTTON_STYLE, opacity: tick <= 1 ? 0.55 : 1 }}>
          Prev
        </button>
        <button type="button" onClick={onNextTick} disabled={tick >= maxTick} style={{ ...BUTTON_STYLE, opacity: tick >= maxTick ? 0.55 : 1 }}>
          Next
        </button>
        <span style={{ alignSelf: 'center', fontSize: 13, color: '#e7f0ff' }}>
          Tick {Math.min(tick, maxTick)} / {maxTick}
        </span>
      </div>
      <input
        type="range"
        min={1}
        max={maxTick}
        value={Math.min(tick, maxTick)}
        onChange={(e) => onSeekTick(Number(e.target.value))}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#e7f0ff' }}>
        <label htmlFor="playback-speed">Speed</label>
        <select
          id="playback-speed"
          value={String(speed)}
          onChange={(e) => onSpeedChange(e.target.value === 'irl' ? 'irl' : Number(e.target.value))}
          style={{
            color: '#eef4ff',
            background: '#243a5b',
            border: '1px solid #6f8fc0',
            borderRadius: 6,
            padding: '4px 8px',
          }}
        >
          {SPEED_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
