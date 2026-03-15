type PlaybackControlsProps = {
  playing: boolean;
  tick: number;
  totalTicks: number;
  speed: number;
  onPlayPause: () => void;
  onPrevTick: () => void;
  onNextTick: () => void;
  onSeekTick: (tick: number) => void;
  onSpeedChange: (speed: number) => void;
};

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4, 8];

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
        <button type="button" onClick={onPlayPause}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" onClick={onPrevTick} disabled={tick <= 1}>
          Prev
        </button>
        <button type="button" onClick={onNextTick} disabled={tick >= maxTick}>
          Next
        </button>
        <span style={{ alignSelf: 'center', fontSize: 13 }}>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label htmlFor="playback-speed">Speed</label>
        <select
          id="playback-speed"
          value={String(speed)}
          onChange={(e) => onSpeedChange(Number(e.target.value))}
        >
          {SPEED_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}x
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
