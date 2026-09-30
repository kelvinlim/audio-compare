import { useRef, useState, type PointerEvent } from "react";
import type { CueInterval } from "./listeningTips";

export interface LoopRegion {
  start: number;
  end: number;
}

export const MIN_LOOP_SECONDS = 0.25;
/** Pointer travel that counts as a drag rather than a seek click. */
const DRAG_THRESHOLD_PX = 6;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function timeAtClientX(track: HTMLElement, clientX: number, duration: number): number {
  const rect = track.getBoundingClientRect();
  const width = Math.max(rect.width, 1);
  const ratio = clamp((clientX - rect.left) / width, 0, 1);
  return ratio * duration;
}

export function formatLoopRange(loop: LoopRegion): string {
  return `${formatTime(loop.start)}–${formatTime(loop.end)}`;
}

function cueKey(cue: CueInterval): string {
  return `${cue.range}-${cue.start}`;
}

/** Resume inside an active loop after a reload that zeroed the playhead. */
export function resumePositionInLoop(
  position: number | null | undefined,
  loop: LoopRegion,
): number {
  if (
    position != null &&
    Number.isFinite(position) &&
    position >= loop.start &&
    position < loop.end
  ) {
    return position;
  }
  return loop.start;
}

export function Timeline({
  duration,
  position,
  cues,
  loop,
  disabled,
  onSeek,
  onLoop,
}: {
  duration: number;
  position: number;
  cues: CueInterval[];
  loop: LoopRegion | null;
  disabled?: boolean;
  onSeek: (seconds: number) => void;
  onLoop: (region: LoopRegion) => void;
}) {
  const dragRef = useRef<{
    pointerId: number;
    originTime: number;
    originX: number;
    moved: boolean;
  } | null>(null);
  const [draft, setDraft] = useState<LoopRegion | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const safeDuration = duration > 0 ? duration : 0.01;
  const playhead = clamp(position, 0, safeDuration);
  const hoverCue = hoverKey
    ? (cues.find((cue) => cueKey(cue) === hoverKey) ?? null)
    : null;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || duration <= 0) {
      return;
    }
    event.preventDefault();
    setHoverKey(null);
    const time = timeAtClientX(event.currentTarget, event.clientX, duration);
    dragRef.current = {
      pointerId: event.pointerId,
      originTime: time,
      originX: event.clientX,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || duration <= 0) {
      return;
    }
    if (!drag.moved && Math.abs(event.clientX - drag.originX) < DRAG_THRESHOLD_PX) {
      return;
    }
    drag.moved = true;
    const time = timeAtClientX(event.currentTarget, event.clientX, duration);
    const start = Math.min(drag.originTime, time);
    const end = Math.max(drag.originTime, time);
    setDraft({ start, end });
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setDraft(null);
    if (duration <= 0) {
      return;
    }
    const time = timeAtClientX(event.currentTarget, event.clientX, duration);
    if (drag.moved) {
      const start = Math.min(drag.originTime, time);
      const end = Math.max(drag.originTime, time);
      if (end - start >= MIN_LOOP_SECONDS) {
        onLoop({ start, end });
      }
      return;
    }
    onSeek(drag.originTime);
  };

  const selection = draft ?? loop;

  return (
    <div
      className={`timeline${disabled ? " is-disabled" : ""}`}
      role="slider"
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={Number(safeDuration.toFixed(2))}
      aria-valuenow={Number(playhead.toFixed(2))}
      aria-valuetext={`${formatTime(playhead)} of ${formatTime(duration)}`}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={() => {
        dragRef.current = null;
        setDraft(null);
        setHoverKey(null);
      }}
    >
      <div className="timeline-track" />
      {duration > 0 &&
        cues.map((cue) => {
        const left = (cue.start / safeDuration) * 100;
        const width = ((cue.end - cue.start) / safeDuration) * 100;
        const active = playhead >= cue.start && playhead < cue.end;
        return (
          <div
            key={`${cue.range}-${cue.start}`}
            className={`timeline-cue${active ? " is-active" : ""}`}
            style={{ left: `${left}%`, width: `${Math.max(width, 0.6)}%` }}
            onPointerEnter={() => {
              if (!dragRef.current) {
                setHoverKey(cueKey(cue));
              }
            }}
            onPointerLeave={() => {
              setHoverKey((current) => (current === cueKey(cue) ? null : current));
            }}
          />
        );
      })}
      {hoverCue && duration > 0 && (
        <div
          className="timeline-cue-tooltip"
          role="tooltip"
          style={{
            left: `${Math.min(
              92,
              Math.max(8, ((hoverCue.start + hoverCue.end) / 2 / safeDuration) * 100),
            )}%`,
          }}
        >
          <span className="cue-range">{hoverCue.range}</span>
          <span>{hoverCue.note}</span>
        </div>
      )}
      {duration > 0 && selection && (
        <div
          className={`timeline-loop${draft ? " is-draft" : ""}`}
          style={{
            left: `${(selection.start / safeDuration) * 100}%`,
            width: `${((selection.end - selection.start) / safeDuration) * 100}%`,
          }}
          title={`Loop ${formatLoopRange(selection)}`}
        />
      )}
      <div
        className="timeline-playhead"
        style={{ left: `${(playhead / safeDuration) * 100}%` }}
      />
    </div>
  );
}
