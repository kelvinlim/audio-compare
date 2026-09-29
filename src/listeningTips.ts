import raw from "../assets/tracks/listening-tips.json";

export interface Cue {
  range: string;
  note: string;
}

export interface TrackTip {
  title: string;
  stresses: string;
  lossyDoes: string;
  listenWhere: Cue[];
  howToUse: string;
}

export interface ListeningGuide {
  general: {
    title: string;
    paragraphs: string[];
  };
  generic: TrackTip;
  tracks: Record<string, TrackTip>;
}

export const listeningGuide = raw as ListeningGuide;

export const bundledTipOrder = Object.keys(listeningGuide.tracks);

export function bundledTrackId(trackId: string): string {
  return trackId.startsWith("bundled:") ? trackId.slice("bundled:".length) : trackId;
}

export function tipForTrack(trackId: string | null | undefined): TrackTip | null {
  if (!trackId) {
    return null;
  }
  if (trackId.startsWith("user:")) {
    return listeningGuide.generic;
  }
  const id = bundledTrackId(trackId);
  return listeningGuide.tracks[id] ?? null;
}

export interface CueInterval {
  start: number;
  end: number;
  range: string;
  note: string;
}

/** Parse a player clock like `1:04` or `0:14.6`. */
export function parseClock(text: string): number | null {
  const match = text.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) {
    return null;
  }
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds >= 60) {
    return null;
  }
  return minutes * 60 + seconds;
}

/** Parse `0:36–0:53` (en-dash, em-dash, or hyphen) into seconds. */
export function parseCueRange(range: string): { start: number; end: number } | null {
  const parts = range.split(/\s*[–—-]\s*/);
  if (parts.length !== 2) {
    return null;
  }
  const start = parseClock(parts[0]);
  const end = parseClock(parts[1]);
  if (start == null || end == null || end <= start) {
    return null;
  }
  return { start, end };
}

export function cueIntervals(trackId: string | null | undefined): CueInterval[] {
  const tip = tipForTrack(trackId);
  if (!tip) {
    return [];
  }
  const cues: CueInterval[] = [];
  for (const cue of tip.listenWhere) {
    const parsed = parseCueRange(cue.range);
    if (!parsed) {
      continue;
    }
    cues.push({ ...parsed, range: cue.range, note: cue.note });
  }
  return cues;
}

export function cueContaining(cues: CueInterval[], seconds: number): CueInterval | null {
  return cues.find((cue) => seconds >= cue.start && seconds < cue.end) ?? null;
}
