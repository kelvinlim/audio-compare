export type SessionMode = "open" | "blind";
export type Source = "a" | "b";

export interface FfmpegStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  hasLame: boolean;
  hasOpus: boolean;
}

export interface DeviceInfo {
  name: string;
  isDefault: boolean;
  sampleRate: number;
  channels: number;
}

export interface Track {
  id: string;
  title: string;
  path: string;
  source: "bundled" | "user";
  genre: string | null;
  license: string | null;
  durationSeconds: number | null;
}

export interface Library {
  bundled: Track[];
  user: Track[];
}

export interface CodecOption {
  id: string;
  label: string;
  bitrates: number[];
}

export interface PlayerStatus {
  playing: boolean;
  source: Source;
  positionSeconds: number;
  durationSeconds: number;
  sampleRate: number;
  loaded: boolean;
  buffersDiffer: boolean;
  diffRms: number;
}

export interface Trial {
  index: number;
  xIs: Source;
  vote: Source | null;
  correct: boolean | null;
}

export interface Session {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trackId: string;
  trackTitle: string;
  codec: string;
  bitrate: number;
  mode: SessionMode;
  trialCount: number;
  seed: number;
  trials: Trial[];
  currentTrial: number;
  correct: number;
  pValue: number;
  complete: boolean;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trackTitle: string;
  codec: string;
  bitrate: number;
  mode: SessionMode;
  trialCount: number;
  correct: number;
  pValue: number;
  complete: boolean;
}

export interface PrepareProgress {
  stage: string;
  message: string;
}

export interface PrepareInfo {
  durationSeconds: number;
  sampleRate: number;
  cached: boolean;
  encodedPath: string;
  diffRms: number;
}

export interface SourceSwitch {
  requested: string;
  applied: boolean;
}
