import { invoke } from "@tauri-apps/api/core";
import type {
  CodecOption,
  DeviceInfo,
  FfmpegStatus,
  Library,
  PlayerStatus,
  PrepareInfo,
  Session,
  SessionMode,
  SessionSummary,
  SourceSwitch,
  Track,
} from "./types";

export const api = {
  checkFfmpeg: () => invoke<FfmpegStatus>("check_ffmpeg"),
  listCodecs: () => invoke<CodecOption[]>("list_codecs"),
  listDevices: () => invoke<DeviceInfo[]>("list_output_devices"),
  setDevice: (name: string | null) =>
    invoke<void>("set_output_device", { name }),
  listLibrary: () => invoke<Library>("list_library"),
  importTrack: (path: string) => invoke<Track>("import_track", { path }),
  prepareComparison: (trackId: string, codec: string, bitrate: number) =>
    invoke<PrepareInfo>("prepare_comparison", { trackId, codec, bitrate }),
  play: () => invoke<void>("player_play"),
  pause: () => invoke<void>("player_pause"),
  seek: (seconds: number) => invoke<void>("player_seek", { seconds }),
  setSource: (source: "a" | "b" | "x") =>
    invoke<SourceSwitch>("player_set_source", { source }),
  playerStatus: () => invoke<PlayerStatus>("player_status"),
  startSession: (
    trackId: string,
    codec: string,
    bitrate: number,
    mode: SessionMode,
    trialCount: number,
  ) =>
    invoke<Session>("start_session", {
      trackId,
      codec,
      bitrate,
      mode,
      trialCount,
    }),
  vote: (choice: "a" | "b") => invoke<Session>("vote", { choice }),
  currentSession: () => invoke<Session | null>("current_session"),
  listHistory: () => invoke<SessionSummary[]>("list_history"),
};
