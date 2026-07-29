'use client';

/**
 * The only interruption mechanism in this MVP. PLAN.md §5.
 * Push-to-talk: press kills TTS playback instantly (barge-in) and opens the mic;
 * release closes it. Large, friendly, and always visible.
 */
export default function TalkButton({
  listening,
  disabled,
  onPress,
  onRelease,
}: {
  listening: boolean;
  disabled: boolean;
  onPress: () => void;
  onRelease: () => void;
}) {
  return (
    <div className="talk-dock">
      <button
        className={`talk-button${listening ? ' listening' : ''}`}
        disabled={disabled}
        aria-label="Hold to talk to Ollie"
        onPointerDown={(e) => {
          e.preventDefault();
          if (!disabled) onPress();
        }}
        onPointerUp={(e) => {
          e.preventDefault();
          onRelease();
        }}
        onPointerLeave={() => {
          if (listening) onRelease();
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        🦉
      </button>
      <div className="talk-hint">
        {listening ? "I'm listening!" : 'Hold Ollie to talk'}
      </div>
    </div>
  );
}
