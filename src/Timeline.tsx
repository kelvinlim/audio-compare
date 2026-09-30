import { useRef, useState, type PointerEvent } from "react";
import type { CueInterval } from "./listeningTips";

export interface LoopRegion {
  start: number;
  end: number;
}

export const MIN_LOOP_SECONDS = 0.25;
/** Pointer travel that counts as a drag rather than a seek click. */
const DRAG_THRESHOLD_PX = 6;
/** Second click on the same cue within this window sets that cue as the A–B loop. */
const DOUBLE_CLICK_MS = 500;
/** Visible width for a zero-length Loop-in preview so the overlay appears immediately. */
const LOOP_IN_MIN_WIDTH_PX = 4;

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

/** Live A–B preview from Loop in to the playhead (order-independent). */
export function loopPreviewRegion(
  loopIn: number | null,
  position: number,
): LoopRegion | null {
  if (loopIn == null || !Number.isFinite(loopIn) || !Number.isFinite(position)) {
    return null;
  }
  return {
    start: Math.min(loopIn, position),
    end: Math.max(loopIn, position),
  };
}

export function cueAtTime(cues: CueInterval[], time: number): CueInterval | null {
  if (!Number.isFinite(time)) {
    return null;
  }
  return cues.find((cue) => time >= cue.start && time < cue.end) ?? null;
}

export function Timeline({
  duration,
  position,
  cues,
  loop,
  loopIn = null,
  disabled,
  onSeek,
  onLoop,
  onLoopCue,
}: {
  duration: number;
  position: number;
  cues: CueInterval[];
  loop: LoopRegion | null;
  loopIn?: number | null;
  disabled?: boolean;
  onSeek: (seconds: number) => void;
  onLoop: (region: LoopRegion) => void;
  onLoopCue?: (cue: CueInterval) => void;
}) {
  const dragRef = useRef<{
    pointerId: number;
    originTime: number;
    originX: number;
    moved: boolean;
  } | null>(null);
  const pendingCueClickRef = useRef<{ key: string; at: number } | null>(null);
  const lastCueLoopAtRef = useRef(0);
  const [draft, setDraft] = useState<LoopRegion | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const safeDuration = duration > 0 ? duration : 0.01;
  const playhead = clamp(position, 0, safeDuration);
  const hoverCue = hoverKey
    ? (cues.find((cue) => cueKey(cue) === hoverKey) ?? null)
    : null;
  const preview = !draft && !loop ? loopPreviewRegion(loopIn, playhead) : null;
  const selection = draft ?? loop ?? preview;
  const defining = preview != null;

  const applyCueLoop = (cue: CueInterval) => {
    if (!onLoopCue) {
      return;
    }
    const now = performance.now();
    if (now - lastCueLoopAtRef.current < 80) {
      return;
    }
    lastCueLoopAtRef.current = now;
    pendingCueClickRef.current = null;
    onLoopCue(cue);
  };

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
      pendingCueClickRef.current = null;
      const start = Math.min(drag.originTime, time);
      const end = Math.max(drag.originTime, time);
      if (end - start >= MIN_LOOP_SECONDS) {
        onLoop({ start, end });
      }
      return;
    }
    // Native dblclick is unreliable here: pointerdown calls preventDefault so
    // the track can capture a drag. Treat a second click on the same cue as
    // loop-that-region; a single click still seeks.
    const cue = onLoopCue ? cueAtTime(cues, drag.originTime) : null;
    const now = performance.now();
    const pending = pendingCueClickRef.current;
    if (
      cue &&
      pending &&
      pending.key === cueKey(cue) &&
      now - pending.at <= DOUBLE_CLICK_MS
    ) {
      pendingCueClickRef.current = null;
      applyCueLoop(cue);
      return;
    }
    pendingCueClickRef.current = cue ? { key: cueKey(cue), at: now } : null;
    onSeek(drag.originTime);
  };

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
        pendingCueClickRef.current = null;
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
            onDoubleClick={
              onLoopCue
                ? (event) => {
                    event.stopPropagation();
                    applyCueLoop(cue);
                  }
                : undefined
            }
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
          {onLoopCue && <span className="cue-hint">Double-click to loop</span>}
        </div>
      )}
      {duration > 0 && loopIn != null && !loop && !draft && (
        <div
          className="timeline-loop-in"
          style={{ left: `${(clamp(loopIn, 0, safeDuration) / safeDuration) * 100}%` }}
          title={`Loop in ${formatTime(loopIn)}`}
        />
      )}
      {duration > 0 && selection && (
        <div
          className={`timeline-loop${draft ? " is-draft" : ""}${defining ? " is-defining" : ""}`}
          style={{
            left: `${(selection.start / safeDuration) * 100}%`,
            width: `${((selection.end - selection.start) / safeDuration) * 100}%`,
            minWidth: defining ? LOOP_IN_MIN_WIDTH_PX : undefined,
          }}
          title={
            defining && loopIn != null
              ? `Loop in ${formatTime(loopIn)}`
              : `Loop ${formatLoopRange(selection)}`
          }
        />
      )}
      <div
        className="timeline-playhead"
        style={{ left: `${(playhead / safeDuration) * 100}%` }}
      />
    </div>
  );
}
