import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import changelog from "../CHANGELOG.md?raw";
import { api } from "./api";
import { bundledTipOrder, cueIntervals, listeningGuide, parseCueRange, tipForTrack } from "./listeningTips";
import type { CueInterval } from "./listeningTips";
import {
  formatLoopRange,
  MIN_LOOP_SECONDS,
  resumePositionInLoop,
  Timeline,
  type LoopRegion,
} from "./Timeline";
import type {
  CodecOption,
  DeviceInfo,
  FfmpegStatus,
  Library,
  PlayerStatus,
  PrepareProgress,
  Session,
  SessionMode,
  SessionSummary,
  Track,
} from "./types";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatLag(frames: number, ms: number): string {
  if (!Number.isFinite(frames) || frames === 0) {
    return "lag 0";
  }
  const side = frames > 0 ? "B later" : "A later";
  const frameLabel = frames > 0 ? `+${frames}` : `${frames}`;
  const msLabel = `${ms > 0 ? "+" : ""}${ms.toFixed(1)}`;
  return `lag ${frameLabel} smp / ${msLabel} ms (${side})`;
}

function sourceFormatLabel(path: string | undefined): string {
  const ext = path?.split(".").pop()?.toLowerCase();
  if (ext === "wav" || ext === "wave") {
    return "WAV";
  }
  if (ext === "aiff" || ext === "aif") {
    return "AIFF";
  }
  if (ext === "flac") {
    return "FLAC";
  }
  return "Lossless";
}

function formatP(p: number): string {
  if (p < 0.001) {
    return "p < 0.001";
  }
  return `p = ${p.toFixed(3)}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const REPO_URL = "https://github.com/kelvinlim/audio-compare";

function codecLabel(codecs: CodecOption[], id: string): string {
  return codecs.find((item) => item.id === id)?.label ?? id.toUpperCase();
}

const FALLBACK_CODECS: CodecOption[] = [
  { id: "mp3", label: "MP3 (LAME)", bitrates: [320, 192, 128, 96, 64, 32] },
  { id: "opus", label: "Opus", bitrates: [128, 96, 64, 32] },
];

const DEFAULT_TRACK_ID = "bundled:jahzzar-missing-you";
const DEFAULT_CODEC = "mp3";
const DEFAULT_BITRATE = 32;
const PREPARE_CANCELLED = "prepare was cancelled";

function isPrepareCancelled(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(PREPARE_CANCELLED);
}

/** Arrow-key seek after scrubbing: ~2% of the track, clamped to 1–10s. */
function seekStepSeconds(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 5;
  }
  return Math.min(10, Math.max(1, duration * 0.02));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.tagName === "SELECT" || target.tagName === "TEXTAREA") {
    return true;
  }
  if (target.tagName !== "INPUT") {
    return false;
  }
  // Timeline range keeps focus after a drag; arrow keys must still seek.
  return (target as HTMLInputElement).type !== "range";
}

function yieldPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

const FALLBACK_DEVICE: DeviceInfo = {
  name: "System default",
  isDefault: true,
  sampleRate: 48000,
  channels: 2,
};

async function loadSafely<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function bakedVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
}

/** Prefer Tauri's packaged version (tauri.conf.json) over the Vite bake-time define. */
function useAppVersion(): string {
  const [version, setVersion] = useState(bakedVersion);
  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((runtime) => {
        if (!cancelled && runtime) {
          setVersion(runtime);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}

export default function App() {
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [library, setLibrary] = useState<Library>({ bundled: [], user: [] });
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [deviceName, setDeviceName] = useState<string>("");
  const [codecs, setCodecs] = useState<CodecOption[]>([]);
  const [trackId, setTrackId] = useState(DEFAULT_TRACK_ID);
  const [codec, setCodec] = useState(DEFAULT_CODEC);
  const [bitrate, setBitrate] = useState(DEFAULT_BITRATE);
  const [mode, setMode] = useState<SessionMode>("open");
  const [trialCount, setTrialCount] = useState(8);
  const [session, setSession] = useState<Session | null>(null);
  const [player, setPlayer] = useState<PlayerStatus | null>(null);
  const [listenSource, setListenSource] = useState<"a" | "b" | "x">("a");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | "about" | "tips">(null);
  const [loop, setLoop] = useState<LoopRegion | null>(null);
  const [loopIn, setLoopIn] = useState<number | null>(null);
  const [switchingTitle, setSwitchingTitle] = useState<string | null>(null);
  const positionRef = useRef(0);
  const durationRef = useRef(0);
  const ignorePollUntilRef = useRef(0);
  const busyRef = useRef(false);
  const sessionRef = useRef<Session | null>(null);
  const prepareGenRef = useRef(0);
  const appVersion = useAppVersion();
  sessionRef.current = session;

  const tracks = useMemo(
    () => [...library.bundled, ...library.user],
    [library],
  );
  const selectedTrack = tracks.find((track) => track.id === trackId) ?? null;
  const codecOptions = codecs.length > 0 ? codecs : FALLBACK_CODECS;
  const selectedCodec = codecOptions.find((item) => item.id === codec);
  const deviceOptions = devices.length > 0 ? devices : [FALLBACK_DEVICE];
  const inSession = session !== null;
  const abxHistory = useMemo(
    () => history.filter((item) => item.mode === "blind" && item.complete).slice(0, 12),
    [history],
  );

  const applyLibrary = useCallback((lib: Library) => {
    setLibrary(lib);
    setTrackId((current) => {
      if (current && [...lib.bundled, ...lib.user].some((t) => t.id === current)) {
        return current;
      }
      return (
        lib.bundled.find((track) => track.id === DEFAULT_TRACK_ID)?.id ??
        lib.bundled[0]?.id ??
        lib.user[0]?.id ??
        ""
      );
    });
  }, []);

  const refresh = useCallback(async () => {
    const [ffmpegStatus, lib, hist, deviceList, codecList] = await Promise.all([
      loadSafely(api.checkFfmpeg),
      loadSafely(api.listLibrary),
      loadSafely(api.listHistory),
      loadSafely(api.listDevices),
      loadSafely(api.listCodecs),
    ]);
    if (ffmpegStatus) {
      setFfmpeg(ffmpegStatus);
    }
    if (lib) {
      applyLibrary(lib);
    }
    if (hist) {
      setHistory(hist);
    }
    if (codecList && codecList.length > 0) {
      setCodecs(codecList);
    }
    const resolvedDevices = deviceList && deviceList.length > 0 ? deviceList : [FALLBACK_DEVICE];
    setDevices(resolvedDevices);
    setDeviceName((current) => {
      if (current && resolvedDevices.some((d) => d.name === current)) {
        return current;
      }
      return resolvedDevices.find((d) => d.isDefault)?.name ?? resolvedDevices[0].name;
    });
    if (!lib) {
      setError("Could not load the track library. Try Import, or restart the app.");
    }
  }, [applyLibrary]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unlisten = listen<PrepareProgress>("prepare-progress", (event) => {
      setProgress(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!inSession) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const status = await api.playerStatus();
        if (!cancelled) {
          if (performance.now() < ignorePollUntilRef.current) {
            return;
          }
          positionRef.current = status.positionSeconds;
          durationRef.current = status.durationSeconds;
          setPlayer(status);
        }
      } catch {
        // keep last known status
      }
    };
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 120);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [inSession]);

  useEffect(() => {
    if (!selectedCodec) {
      return;
    }
    if (!selectedCodec.bitrates.includes(bitrate)) {
      setBitrate(selectedCodec.bitrates[0]);
    }
  }, [selectedCodec, bitrate]);

  const seekTo = useCallback(async (seconds: number) => {
    const duration = durationRef.current;
    const next =
      duration > 0
        ? Math.min(Math.max(0, seconds), duration)
        : Math.max(0, seconds);
    positionRef.current = next;
    ignorePollUntilRef.current = performance.now() + 180;
    setPlayer((current) =>
      current ? { ...current, positionSeconds: next } : current,
    );
    await api.seek(next);
  }, []);

  const changeDevice = async (name: string) => {
    if (busyRef.current) {
      return;
    }
    setDeviceName(name);
    await api.setDevice(name);
    if (session && trackId) {
      const restoreLoop = loop;
      const restorePosition = positionRef.current;
      const gen = prepareGenRef.current;
      busyRef.current = true;
      setBusy(true);
      try {
        await api.prepareComparison(trackId, session.codec, session.bitrate);
        if (gen !== prepareGenRef.current || !sessionRef.current) {
          return;
        }
        if (restoreLoop) {
          await api.setLoop(restoreLoop.start, restoreLoop.end);
          // load() zeros the playhead; wrap only fires at/after loop_end.
          await seekTo(resumePositionInLoop(restorePosition, restoreLoop));
        }
      } catch (err) {
        if (gen === prepareGenRef.current && sessionRef.current && !isPrepareCancelled(err)) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (gen === prepareGenRef.current) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    }
  };

  const clearLoop = useCallback(async () => {
    setLoop(null);
    setLoopIn(null);
    try {
      await api.setLoop(null, null);
    } catch {
      // player may not be loaded yet
    }
  }, []);

  const applyLoop = useCallback(
    async (region: LoopRegion, seek: boolean) => {
      if (region.end - region.start < MIN_LOOP_SECONDS) {
        return;
      }
      setLoop(region);
      setLoopIn(null);
      await api.setLoop(region.start, region.end);
      if (seek) {
        await seekTo(region.start);
      }
    },
    [seekTo],
  );

  const beginListening = async (nextTrackId: string) => {
    if (!nextTrackId) {
      setError("Pick a track first.");
      return;
    }
    const gen = ++prepareGenRef.current;
    setError(null);
    setPanel(null);
    busyRef.current = true;
    setBusy(true);
    const nextTitle = tracks.find((track) => track.id === nextTrackId)?.title;
    setSwitchingTitle(nextTitle ?? null);
    setProgress({
      stage: "start",
      message: nextTitle ? `Preparing ${nextTitle}…` : "Preparing comparison…",
    });
    try {
      await api.invalidatePrepare();
      await clearLoop();
      await yieldPaint();
      if (gen !== prepareGenRef.current) {
        return;
      }
      if (sessionRef.current) {
        await api.pause();
        if (gen !== prepareGenRef.current) {
          return;
        }
      }
      await api.prepareComparison(nextTrackId, codec, bitrate);
      if (gen !== prepareGenRef.current) {
        return;
      }
      const next = await api.startSession(nextTrackId, codec, bitrate, mode, trialCount);
      if (gen !== prepareGenRef.current) {
        return;
      }
      setTrackId(nextTrackId);
      setSession(next);
      setListenSource("a");
      await api.setSource("a");
      if (gen !== prepareGenRef.current) {
        await api.pause();
        return;
      }
      await api.play();
      if (gen !== prepareGenRef.current) {
        await api.pause();
        return;
      }
      setHistory(await api.listHistory());
    } catch (err) {
      if (gen === prepareGenRef.current && !isPrepareCancelled(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (gen === prepareGenRef.current) {
        busyRef.current = false;
        setBusy(false);
        setProgress(null);
        setSwitchingTitle(null);
      }
    }
  };

  const selectTrack = (id: string) => {
    if (busyRef.current) {
      return;
    }
    if (!sessionRef.current) {
      setTrackId(id);
      return;
    }
    if (id === trackId) {
      return;
    }
    void beginListening(id);
  };

  const importFile = async () => {
    if (busyRef.current) {
      return;
    }
    setError(null);
    const selected = await open({
      multiple: false,
      filters: [{ name: "Lossless audio", extensions: ["flac", "wav", "wave", "aiff", "aif"] }],
    });
    if (!selected || Array.isArray(selected)) {
      return;
    }
    const track = await api.importTrack(selected);
    await refresh();
    selectTrack(track.id);
  };

  const start = async () => {
    await beginListening(trackId);
  };

  const switchSource = useCallback(async (source: "a" | "b" | "x") => {
    if (source === "x" && session?.mode !== "blind") {
      return;
    }
    setListenSource(source);
    try {
      const result = await api.setSource(source);
      if (!result.applied) {
        setError(`Could not switch to ${source.toUpperCase()}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [session?.mode]);

  const cycleSource = useCallback(() => {
    const order: Array<"a" | "b" | "x"> =
      session?.mode === "blind" ? ["a", "b", "x"] : ["a", "b"];
    const index = order.indexOf(listenSource);
    const next = order[(index < 0 ? 0 : index + 1) % order.length];
    void switchSource(next);
  }, [listenSource, session?.mode, switchSource]);

  const togglePlay = useCallback(async () => {
    if (player?.playing) {
      await api.pause();
    } else {
      await api.play();
    }
  }, [player?.playing]);

  const submitVote = useCallback(async (choice: "a" | "b") => {
    if (!session || session.mode !== "blind" || session.complete) {
      return;
    }
    const next = await api.vote(choice);
    setSession(next);
    setListenSource("x");
    await api.setSource("x");
    setHistory(await api.listHistory());
  }, [session]);

  const endSession = useCallback(async () => {
    prepareGenRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setProgress(null);
    setSwitchingTitle(null);
    try {
      await api.invalidatePrepare();
    } catch {
      // Tear the session down even if the engine call fails.
    }
    await api.pause();
    await clearLoop();
    setSession(null);
    setPlayer(null);
    positionRef.current = 0;
    durationRef.current = 0;
    setListenSource("a");
    setHistory(await api.listHistory());
  }, [clearLoop]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (panel) {
          event.preventDefault();
          setPanel(null);
          return;
        }
        if (inSession) {
          event.preventDefault();
          void endSession();
        }
        return;
      }

      if (!inSession || panel) {
        return;
      }
      if (busy) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === " " || event.code === "Space") {
        event.preventDefault();
        void togglePlay();
      } else if (key === "a") {
        void switchSource("a");
      } else if (key === "b") {
        void switchSource("b");
      } else if (key === "x") {
        void switchSource("x");
      } else if (key === "1") {
        void submitVote("a");
      } else if (key === "2") {
        void submitVote("b");
      } else if (key === "tab") {
        event.preventDefault();
        cycleSource();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        // preventDefault so a focused timeline range cannot apply its 0.01s
        // native step (the post-scrub "barely moves" bug).
        event.preventDefault();
        const step = seekStepSeconds(durationRef.current);
        const delta = event.key === "ArrowLeft" ? -step : step;
        void seekTo(positionRef.current + delta);
      } else if (event.key === "[") {
        event.preventDefault();
        setLoopIn(positionRef.current);
        if (loop) {
          setLoop(null);
          void api.setLoop(null, null);
        }
      } else if (event.key === "]") {
        event.preventDefault();
        const position = positionRef.current;
        const startAt = loopIn ?? loop?.start ?? null;
        if (startAt != null) {
          const start = Math.min(startAt, position);
          const end = Math.max(startAt, position);
          void applyLoop({ start, end }, false);
        }
      } else if (key === "l") {
        event.preventDefault();
        void clearLoop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    applyLoop,
    busy,
    clearLoop,
    cycleSource,
    endSession,
    inSession,
    loop,
    loopIn,
    panel,
    seekTo,
    submitVote,
    switchSource,
    togglePlay,
  ]);

  return (
    <div className={`app${busy ? " is-preparing" : ""}`} aria-busy={busy}>
      <header className="topbar">
        <div className="brand-block">
          <div className="brand">
            <span className="wordmark">Audio Compare</span>
            <span className="version">{appVersion ? `v${appVersion}` : ""}</span>
            <span className="badge">ABX</span>
          </div>
          <div className="header-links">
            <button
              type="button"
              className="ghost"
              onClick={() => setPanel((current) => (current === "about" ? null : "about"))}
            >
              {panel === "about" ? "Home" : "About"}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setPanel((current) => (current === "tips" ? null : "tips"))}
            >
              {panel === "tips" ? "Home" : "Listening tips"}
            </button>
            {!inSession && (
              <StartListeningButton
                disabled={!selectedTrack || (ffmpeg !== null && !ffmpeg.available)}
                busy={busy}
                onStart={() => void start()}
              />
            )}
          </div>
        </div>
        <DevicePicker
          devices={deviceOptions}
          value={deviceName || deviceOptions[0]?.name || ""}
          disabled={busy}
          onChange={(name) => void changeDevice(name)}
        />
      </header>

      {ffmpeg && !ffmpeg.available && (
        <div className="banner warn">
          The bundled ffmpeg sidecar is missing. Reinstall the app — encoding and
          decoding both depend on it.
        </div>
      )}
      {ffmpeg?.available && (!ffmpeg.hasLame || !ffmpeg.hasOpus) && (
        <div className="banner warn">
          ffmpeg is missing {ffmpeg.hasLame ? "" : "libmp3lame "}
          {ffmpeg.hasOpus ? "" : "libopus"}. Reinstall the app so the bundled
          encoders are present.
        </div>
      )}
      {error && <div className="banner error">{error}</div>}

      {panel === "about" ? (
        <div className="scroll-pane">
          <About version={appVersion} onOpenTips={() => setPanel("tips")} />
        </div>
      ) : panel === "tips" ? (
        <div className="scroll-pane">
          <ListeningTips
            selectedId={selectedTrack?.id ?? trackId}
            onHome={() => setPanel(null)}
          />
        </div>
      ) : (
      <div className="layout">
        <aside className="sidebar">
          <section>
            <div className="section-head">
              <h2>Library</h2>
              <button type="button" className="ghost" disabled={busy} onClick={() => void importFile()}>
                Import
              </button>
            </div>
            <p className="hint">
              Select a track here. Bundled diagnostics plus your own FLAC or WAV.
              {inSession ? " Click another track to restart with that source." : ""}
            </p>
            <button type="button" className="link sidebar-link" onClick={() => setPanel("tips")}>
              What to listen for
            </button>
            <TrackGroup
              label="Bundled"
              tracks={library.bundled}
              selectedId={trackId}
              disabled={busy}
              onSelect={selectTrack}
            />
            <TrackGroup
              label="Your files"
              tracks={library.user}
              selectedId={trackId}
              disabled={busy}
              onSelect={selectTrack}
            />
          </section>
          <section className="history">
            <h2>History</h2>
            {abxHistory.length === 0 && (
              <p className="hint">Completed ABX sessions land here.</p>
            )}
            <ul>
              {abxHistory.map((item) => (
                <li key={item.id}>
                  <strong>{item.trackTitle}</strong>
                  <span>{formatWhen(item.finishedAt ?? item.startedAt)}</span>
                  <span>
                    {item.correct} / {item.trialCount} correct
                    {` · ${formatP(item.pValue)}`}
                    {` · ${item.codec.toUpperCase()} ${item.bitrate}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <main className="main">
          {!inSession ? (
            <Setup
              track={selectedTrack}
              codecs={codecOptions}
              codec={codec}
              bitrate={bitrate}
              mode={mode}
              trialCount={trialCount}
              busy={busy}
              progress={progress}
              onCodec={setCodec}
              onBitrate={setBitrate}
              onMode={setMode}
              onTrials={setTrialCount}
              onOpenTips={() => setPanel("tips")}
            />
          ) : (
            <Player
              session={session}
              player={player}
              listenSource={listenSource}
              codecs={codecOptions}
              busy={busy}
              progress={progress}
              switchingTitle={switchingTitle}
              sourceLabel={sourceFormatLabel(
                tracks.find((track) => track.id === session.trackId)?.path,
              )}
              cues={cueIntervals(session.trackId)}
              loop={loop}
              loopIn={loopIn}
              onSource={(source) => void switchSource(source)}
              onPlay={() => void togglePlay()}
              onSeek={(seconds) => void seekTo(seconds)}
              onLoop={(region) => void applyLoop(region, true)}
              onLoopCue={(cue) => void applyLoop({ start: cue.start, end: cue.end }, true)}
              onLoopIn={() => {
                setLoopIn(positionRef.current);
                if (loop) {
                  setLoop(null);
                  void api.setLoop(null, null);
                }
              }}
              onLoopOut={() => {
                const position = positionRef.current;
                const startAt = loopIn ?? loop?.start ?? null;
                if (startAt != null) {
                  void applyLoop(
                    {
                      start: Math.min(startAt, position),
                      end: Math.max(startAt, position),
                    },
                    false,
                  );
                }
              }}
              onClearLoop={() => void clearLoop()}
              onVote={(choice) => void submitVote(choice)}
              onEnd={() => void endSession()}
              onOpenTips={() => setPanel("tips")}
            />
          )}
        </main>
      </div>
      )}
    </div>
  );
}

function About({
  version,
  onOpenTips,
}: {
  version: string;
  onOpenTips: () => void;
}) {
  const openRepo = async () => {
    try {
      await openUrl(REPO_URL);
    } catch {
      window.open(REPO_URL, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <main className="main about">
      <p className="eyebrow">Audio Compare{version ? ` v${version}` : ""}</p>
      <h1>About</h1>
      <p>
        Source, issues, and releases:{" "}
        <button type="button" className="link" onClick={() => void openRepo()}>
          {REPO_URL}
        </button>
      </p>
      <p>
        Cue times and “what to listen for” on each bundled clip:{" "}
        <button type="button" className="link" onClick={onOpenTips}>
          Listening tips
        </button>
        .
      </p>
      <h2>Changes</h2>
      <pre className="changelog">{changelog.trim()}</pre>
    </main>
  );
}

function ListeningTips({
  selectedId,
  onHome,
}: {
  selectedId: string;
  onHome: () => void;
}) {
  const selectedKey = selectedId.startsWith("bundled:")
    ? selectedId.slice("bundled:".length)
    : "";

  useEffect(() => {
    if (!selectedKey || !listeningGuide.tracks[selectedKey]) {
      return;
    }
    const node = document.getElementById(`tip-${selectedKey}`);
    node?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [selectedKey]);

  return (
    <main className="main about tips">
      <p className="eyebrow">What to listen for</p>
      <h1>Listening tips</h1>
      <p className="lede">
        Practical cues for the bundled clips at ~64–128 kbps. Times are MM:SS on
        the lossless file. They come from 96 kbps MP3 residuals plus a listen
        to each FLAC — not from folklore.
      </p>

      <section className="tip-block">
        <h2>{listeningGuide.general.title}</h2>
        {listeningGuide.general.paragraphs.map((paragraph) => (
          <p key={paragraph.slice(0, 32)}>{paragraph}</p>
        ))}
      </section>

      {bundledTipOrder.map((id) => {
        const tip = listeningGuide.tracks[id];
        return (
          <section
            key={id}
            id={`tip-${id}`}
            className={`tip-block${id === selectedKey ? " selected-tip" : ""}`}
          >
            <TrackTipBody tip={tip} />
          </section>
        );
      })}

      <p className="hint">
        <button type="button" className="link" onClick={onHome}>
          Home
        </button>
      </p>
    </main>
  );
}

function TrackTipBody({
  tip,
  onCueClick,
}: {
  tip: NonNullable<ReturnType<typeof tipForTrack>>;
  onCueClick?: (cue: CueInterval) => void;
}) {
  return (
    <>
      <h2>{tip.title}</h2>
      <p>
        <strong>Stresses. </strong>
        {tip.stresses}
      </p>
      <p>
        <strong>What lossy usually does. </strong>
        {tip.lossyDoes}
      </p>
      <p>
        <strong>Where to listen.</strong>
      </p>
      <ul className="cue-list">
        {tip.listenWhere.map((cue) => {
          const interval = parseCueRange(cue.range);
          return (
            <li key={`${cue.range}-${cue.note.slice(0, 24)}`}>
              {onCueClick && interval ? (
                <button
                  type="button"
                  className="cue-range cue-jump"
                  onClick={() => onCueClick({ ...interval, range: cue.range, note: cue.note })}
                >
                  {cue.range}
                </button>
              ) : (
                <span className="cue-range">{cue.range}</span>
              )}
              <span>{cue.note}</span>
            </li>
          );
        })}
      </ul>
      <p>
        <strong>In the app. </strong>
        {tip.howToUse}
      </p>
    </>
  );
}

function TrackTipCard({
  trackId,
  onOpenTips,
  onCueClick,
}: {
  trackId: string | null | undefined;
  onOpenTips: () => void;
  onCueClick?: (cue: CueInterval) => void;
}) {
  const tip = tipForTrack(trackId);
  if (!tip) {
    return null;
  }
  return (
    <aside className="tip-card">
      <div className="section-head">
        <h2>What to listen for</h2>
        <button type="button" className="link" onClick={onOpenTips}>
          All tips
        </button>
      </div>
      <p>
        <strong>Stresses. </strong>
        {tip.stresses}
      </p>
      <p>
        <strong>Where. </strong>
        {tip.listenWhere.map((cue, index) => {
          const interval = parseCueRange(cue.range);
          return (
            <span key={cue.range}>
              {index > 0 ? "; " : ""}
              {onCueClick && interval ? (
                <button
                  type="button"
                  className="cue-range cue-jump"
                  onClick={() => onCueClick({ ...interval, range: cue.range, note: cue.note })}
                >
                  {cue.range}
                </button>
              ) : (
                <span className="cue-range">{cue.range}</span>
              )}
              {` ${cue.note}`}
            </span>
          );
        })}
      </p>
      <p className="hint">
        {onCueClick
          ? "Click a cue time to loop that region. Drag the timeline for a custom loop."
          : tip.howToUse}
      </p>
    </aside>
  );
}

function TrackGroup({
  label,
  tracks,
  selectedId,
  disabled,
  onSelect,
}: {
  label: string;
  tracks: Track[];
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="group">
      <h3>{label}</h3>
      {tracks.length === 0 && <p className="hint empty">Nothing here yet.</p>}
      <ul>
        {tracks.map((track) => (
          <li key={track.id}>
            <button
              type="button"
              className={track.id === selectedId ? "track selected" : "track"}
              disabled={disabled}
              onClick={() => onSelect(track.id)}
            >
              <span className="title">{track.title}</span>
              <span className="meta">
                {track.genre ?? track.license ?? sourceFormatLabel(track.path)}
                {track.source === "user" ? ` · ${sourceFormatLabel(track.path)}` : ""}
                {track.durationSeconds
                  ? ` · ${formatTime(track.durationSeconds)}`
                  : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Setup({
  track,
  codecs,
  codec,
  bitrate,
  mode,
  trialCount,
  busy,
  progress,
  onCodec,
  onBitrate,
  onMode,
  onTrials,
  onOpenTips,
}: {
  track: Track | null;
  codecs: CodecOption[];
  codec: string;
  bitrate: number;
  mode: SessionMode;
  trialCount: number;
  busy: boolean;
  progress: PrepareProgress | null;
  onCodec: (id: string) => void;
  onBitrate: (rate: number) => void;
  onMode: (mode: SessionMode) => void;
  onTrials: (n: number) => void;
  onOpenTips: () => void;
}) {
  const selected = codecs.find((item) => item.id === codec);
  return (
    <div className="setup">
      <p className="eyebrow">New comparison</p>
      <h1>{track?.title ?? "Choose a lossless track"}</h1>
      <p className="lede">
        Both the original and the encode are decoded to the same PCM stream,
        time-aligned, then switched at the same playhead. You are hearing codec
        artifacts, not player differences or encoder delay.
      </p>
      <p className="hint">
        {track
          ? "Suggested first listen: Jahzzar — Missing You, lossless vs 32 kbps MP3. The difference should be obvious; then try a higher bitrate or another track."
          : "Select a track from the library on the left, or import a FLAC or WAV."}
      </p>
      <TrackTipCard trackId={track?.id} onOpenTips={onOpenTips} />

      <div className="cards">
        <ChoiceRow
          label="Codec"
          value={codec}
          disabled={busy}
          options={codecs.map((item) => ({ value: item.id, label: item.label }))}
          onChange={onCodec}
        />
        <ChoiceRow
          label="Bitrate"
          value={String(bitrate)}
          disabled={busy}
          options={(selected?.bitrates ?? []).map((rate) => ({
            value: String(rate),
            label: `${rate} kbps`,
          }))}
          onChange={(value) => onBitrate(Number(value))}
        />
        <ChoiceRow
          label="Mode"
          value={mode}
          disabled={busy}
          options={[
            { value: "open", label: "Open A/B" },
            { value: "blind", label: "Blind ABX" },
          ]}
          onChange={(value) => onMode(value as SessionMode)}
        />
        <ChoiceRow
          label="Trials"
          value={String(trialCount)}
          disabled={busy || mode === "open"}
          options={[8, 12, 16, 24].map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(value) => onTrials(Number(value))}
        />
      </div>

      {busy && (
        <p className="prepare-status" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {progress?.message ?? "Preparing comparison…"}
        </p>
      )}
    </div>
  );
}

function ChoiceRow({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className={`field ${disabled ? "is-disabled" : ""}`}>
      <span>{label}</span>
      <div className="choices">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            className={option.value === value ? "choice on" : "choice"}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function DevicePicker({
  devices,
  value,
  disabled,
  onChange,
}: {
  devices: DeviceInfo[];
  value: string;
  disabled?: boolean;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = devices.find((device) => device.name === value) ?? devices[0];

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <div className={`device${disabled ? " is-disabled" : ""}`}>
      <span>Output</span>
      <div className="device-menu">
        <button
          type="button"
          className="device-button"
          disabled={disabled}
          title={disabled ? "Wait for prepare to finish" : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          {current
            ? `${current.name}${current.isDefault ? " (default)" : ""} · ${current.sampleRate} Hz`
            : "System default"}
        </button>
        {open && !disabled && (
          <ul className="device-list">
            {devices.map((device) => (
              <li key={device.name}>
                <button
                  type="button"
                  className={device.name === current?.name ? "on" : ""}
                  onClick={() => {
                    onChange(device.name);
                    setOpen(false);
                  }}
                >
                  {device.name}
                  {device.isDefault ? " (default)" : ""} · {device.sampleRate} Hz
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Player({
  session,
  player,
  listenSource,
  codecs,
  busy,
  progress,
  switchingTitle,
  sourceLabel,
  cues,
  loop,
  loopIn,
  onSource,
  onPlay,
  onSeek,
  onLoop,
  onLoopCue,
  onLoopIn,
  onLoopOut,
  onClearLoop,
  onVote,
  onEnd,
  onOpenTips,
}: {
  session: Session;
  player: PlayerStatus | null;
  listenSource: "a" | "b" | "x";
  codecs: CodecOption[];
  busy: boolean;
  progress: PrepareProgress | null;
  switchingTitle: string | null;
  sourceLabel: string;
  cues: CueInterval[];
  loop: LoopRegion | null;
  loopIn: number | null;
  onSource: (source: "a" | "b" | "x") => void;
  onPlay: () => void;
  onSeek: (seconds: number) => void;
  onLoop: (region: LoopRegion) => void;
  onLoopCue: (cue: CueInterval) => void;
  onLoopIn: () => void;
  onLoopOut: () => void;
  onClearLoop: () => void;
  onVote: (choice: "a" | "b") => void;
  onEnd: () => void;
  onOpenTips: () => void;
}) {
  const duration = player?.durationSeconds ?? 0;
  const position = player?.positionSeconds ?? 0;
  const open = session.mode === "open";
  const answered = session.currentTrial;
  const remaining = Math.max(0, session.trialCount - answered);
  const aCaption = open ? sourceLabel : "Reference A";

  return (
    <div className={`player${busy ? " is-busy" : ""}`}>
      <div className="player-head">
        <div>
          <p className="eyebrow">
            {open ? "Open A/B" : "Blind ABX"} · {codecLabel(codecs, session.codec)}{" "}
            {session.bitrate} kbps
          </p>
          <h1>{switchingTitle ?? session.trackTitle}</h1>
          {busy && (
            <p className="prepare-status" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              {progress?.message ?? "Preparing comparison…"}
            </p>
          )}
        </div>
        <button type="button" className="ghost" onClick={onEnd} disabled={busy}>
          End session
        </button>
      </div>

      <div className="pads">
        <SourcePad
          letter="A"
          caption={aCaption}
          active={listenSource === "a"}
          disabled={busy}
          onClick={() => onSource("a")}
        />
        <SourcePad
          letter="B"
          caption={open ? `${session.codec.toUpperCase()} ${session.bitrate}` : "Reference B"}
          active={listenSource === "b"}
          disabled={busy}
          onClick={() => onSource("b")}
        />
        {!open && (
          <SourcePad
            letter="X"
            caption="Mystery"
            active={listenSource === "x"}
            disabled={busy}
            onClick={() => onSource("x")}
          />
        )}
      </div>

      <p className="engine">
        {open
          ? `Now playing ${player?.source === "b" ? `${session.codec.toUpperCase()} ${session.bitrate}` : sourceLabel} (buffer ${player?.source.toUpperCase() ?? "—"})`
          : `Now playing ${listenSource.toUpperCase()} · engine is reading buffer ${listenSource === "x" ? "X" : (player?.source?.toUpperCase() ?? "—")}`}
        {player && (
          <>
            {" "}
            · A≠B confirmed
            {Number.isFinite(player.diffRms)
              ? ` (Δ RMS ${player.diffRms.toExponential(2)}${
                  Number.isFinite(player.unalignedDiffRms) &&
                  Math.abs(player.unalignedDiffRms - player.diffRms) >
                    player.diffRms * 0.01 + 1e-9
                    ? `, unaligned ${player.unalignedDiffRms.toExponential(2)}`
                    : ""
                }; ${formatLag(player.lagFrames, player.lagMs)})`
              : ""}
          </>
        )}
        {player && !player.buffersDiffer && " · warning: buffers look identical"}
      </p>

      <div className="transport">
        <button
          type="button"
          className="play"
          onClick={onPlay}
          disabled={busy}
          aria-label={player?.playing ? "Pause" : "Play"}
          title={player?.playing ? "Pause" : "Play"}
        >
          <PlayPauseIcon playing={Boolean(player?.playing)} />
        </button>
        <Timeline
          duration={duration}
          position={position}
          cues={cues}
          loop={loop}
          disabled={busy}
          onSeek={onSeek}
          onLoop={onLoop}
        />
        <span className="clock">
          {formatTime(position)} / {formatTime(duration)}
        </span>
      </div>

      <div className="loop-bar">
        {loop ? (
          <>
            <span>
              Looping {formatLoopRange(loop)}
            </span>
            <button type="button" className="ghost" onClick={onClearLoop} disabled={busy}>
              Clear loop
            </button>
          </>
        ) : (
          <>
            <span>
              {loopIn != null
                ? `Loop in ${formatTime(loopIn)} — press Loop out or ]`
                : "Drag the timeline to loop, or click a cue time"}
            </span>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={loopIn != null ? onLoopOut : onLoopIn}
            >
              {loopIn != null ? "Loop out" : "Loop in"}
            </button>
          </>
        )}
      </div>

      <p className="keys">
        A / B{open ? "" : " / X"} switch · Tab cycle · Space play · Esc end · ← → seek
        · [ ] loop in/out · L clear
        {open ? "" : " · 1 / 2 vote X is A or B"}
      </p>

      <TrackTipCard
        trackId={session.trackId}
        onOpenTips={onOpenTips}
        onCueClick={busy ? undefined : onLoopCue}
      />

      {!open && (
        <div className="scoreboard">
          {session.complete ? (
            <div>
              <h2>Session complete</h2>
              <p className="score">
                {session.correct} / {session.trialCount} correct
              </p>
              <p className="hint">
                {formatP(session.pValue)} · one-sided binomial vs chance. Below 0.05
                is the usual “I can hear a difference” threshold.
              </p>
            </div>
          ) : (
            <div>
              <h2>Is X the same as A or B?</h2>
              <div className="vote-row">
                <button type="button" onClick={() => onVote("a")} disabled={busy}>
                  X is A
                </button>
                <button type="button" onClick={() => onVote("b")} disabled={busy}>
                  X is B
                </button>
              </div>
              <p className="hint">
                Trial {Math.min(answered + 1, session.trialCount)} of {session.trialCount}
                {answered > 0
                  ? ` · ${session.correct}/${answered} so far · ${formatP(session.pValue)}`
                  : ""}
                {remaining ? ` · ${remaining} left` : ""}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StartListeningButton({
  disabled,
  busy,
  onStart,
}: {
  disabled: boolean;
  busy: boolean;
  onStart: () => void;
}) {
  return (
    <button
      type="button"
      className={`primary header-start${busy ? " is-busy" : ""}`}
      disabled={disabled || busy}
      onClick={onStart}
      aria-busy={busy}
    >
      {busy && <span className="spinner" aria-hidden="true" />}
      <span>{busy ? "Preparing…" : "Start listening"}</span>
    </button>
  );
}

function PlayPauseIcon({ playing }: { playing: boolean }) {
  if (playing) {
    return (
      <svg className="play-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="4" width="5" height="16" rx="1.2" />
        <rect x="14" y="4" width="5" height="16" rx="1.2" />
      </svg>
    );
  }
  return (
    <svg className="play-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.2v13.6L19 12 8 5.2z" />
    </svg>
  );
}

function SourcePad({
  letter,
  caption,
  active,
  disabled,
  onClick,
}: {
  letter: string;
  caption: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`pad pad-${letter.toLowerCase()} ${active ? "active" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="letter">{letter}</span>
      <span className="caption">{caption}</span>
    </button>
  );
}
