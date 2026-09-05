import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
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

function formatP(p: number): string {
  if (p < 0.001) {
    return "p < 0.001";
  }
  return `p = ${p.toFixed(3)}`;
}

function codecLabel(codecs: CodecOption[], id: string): string {
  return codecs.find((item) => item.id === id)?.label ?? id.toUpperCase();
}

const FALLBACK_CODECS: CodecOption[] = [
  { id: "mp3", label: "MP3 (LAME)", bitrates: [320, 192, 128] },
  { id: "opus", label: "Opus", bitrates: [128, 96, 64] },
];

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

export default function App() {
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [library, setLibrary] = useState<Library>({ bundled: [], user: [] });
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [deviceName, setDeviceName] = useState<string>("");
  const [codecs, setCodecs] = useState<CodecOption[]>([]);
  const [trackId, setTrackId] = useState<string>("");
  const [codec, setCodec] = useState("mp3");
  const [bitrate, setBitrate] = useState(192);
  const [mode, setMode] = useState<SessionMode>("blind");
  const [trialCount, setTrialCount] = useState(8);
  const [session, setSession] = useState<Session | null>(null);
  const [player, setPlayer] = useState<PlayerStatus | null>(null);
  const [listenSource, setListenSource] = useState<"a" | "b" | "x">("a");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tracks = useMemo(
    () => [...library.bundled, ...library.user],
    [library],
  );
  const selectedTrack = tracks.find((track) => track.id === trackId) ?? null;
  const codecOptions = codecs.length > 0 ? codecs : FALLBACK_CODECS;
  const selectedCodec = codecOptions.find((item) => item.id === codec);
  const deviceOptions = devices.length > 0 ? devices : [FALLBACK_DEVICE];
  const inSession = session !== null;

  const applyLibrary = useCallback((lib: Library) => {
    setLibrary(lib);
    setTrackId((current) => {
      if (current && [...lib.bundled, ...lib.user].some((t) => t.id === current)) {
        return current;
      }
      return lib.bundled[0]?.id ?? lib.user[0]?.id ?? "";
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

  const changeDevice = async (name: string) => {
    setDeviceName(name);
    await api.setDevice(name);
    if (session && trackId) {
      setBusy(true);
      try {
        await api.prepareComparison(trackId, session.codec, session.bitrate);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    }
  };

  const importFile = async () => {
    setError(null);
    const selected = await open({
      multiple: false,
      filters: [{ name: "Lossless audio", extensions: ["flac", "wav", "aiff", "aif"] }],
    });
    if (!selected || Array.isArray(selected)) {
      return;
    }
    const track = await api.importTrack(selected);
    await refresh();
    setTrackId(track.id);
  };

  const start = async () => {
    if (!trackId) {
      setError("Pick a track first.");
      return;
    }
    setError(null);
    setBusy(true);
    setProgress({ stage: "start", message: "Preparing comparison…" });
    try {
      await api.prepareComparison(trackId, codec, bitrate);
      const next = await api.startSession(trackId, codec, bitrate, mode, trialCount);
      setSession(next);
      setListenSource("a");
      await api.setSource("a");
      await api.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
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

  const endSession = async () => {
    await api.pause();
    setSession(null);
    setPlayer(null);
    setListenSource("a");
    setHistory(await api.listHistory());
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!inSession) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) {
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
      } else if (event.key === "ArrowLeft") {
        void api.seek(Math.max(0, (player?.positionSeconds ?? 0) - 5));
      } else if (event.key === "ArrowRight") {
        void api.seek((player?.positionSeconds ?? 0) + 5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inSession, player?.positionSeconds, submitVote, switchSource, togglePlay]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="wordmark">Audio Compare</span>
          <span className="badge">ABX</span>
        </div>
        <DevicePicker
          devices={deviceOptions}
          value={deviceName || deviceOptions[0]?.name || ""}
          onChange={(name) => void changeDevice(name)}
        />
      </header>

      {ffmpeg && !ffmpeg.available && (
        <div className="banner warn">
          ffmpeg was not found. Install it (for example <code>brew install ffmpeg</code>)
          and restart the app. Encoding and decoding both depend on it.
        </div>
      )}
      {ffmpeg?.available && (!ffmpeg.hasLame || !ffmpeg.hasOpus) && (
        <div className="banner warn">
          ffmpeg is missing {ffmpeg.hasLame ? "" : "libmp3lame "}
          {ffmpeg.hasOpus ? "" : "libopus"}. Reinstall a full build so both encoders are present.
        </div>
      )}
      {error && <div className="banner error">{error}</div>}

      <div className="layout">
        <aside className="sidebar">
          <section>
            <div className="section-head">
              <h2>Library</h2>
              <button type="button" className="ghost" onClick={() => void importFile()}>
                Import
              </button>
            </div>
            <p className="hint">Bundled diagnostics plus your own FLAC or WAV.</p>
            <TrackGroup
              label="Bundled"
              tracks={library.bundled}
              selectedId={trackId}
              disabled={inSession}
              onSelect={setTrackId}
            />
            <TrackGroup
              label="Your files"
              tracks={library.user}
              selectedId={trackId}
              disabled={inSession}
              onSelect={setTrackId}
            />
          </section>
          <section className="history">
            <h2>History</h2>
            {history.length === 0 && <p className="hint">Completed blind sessions land here.</p>}
            <ul>
              {history.slice(0, 12).map((item) => (
                <li key={item.id}>
                  <strong>{item.trackTitle}</strong>
                  <span>
                    {item.codec.toUpperCase()} {item.bitrate} ·{" "}
                    {item.mode === "blind"
                      ? `${item.correct}/${item.trialCount} · ${formatP(item.pValue)}`
                      : "open A/B"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <main className="main">
          {!inSession ? (
            <Setup
              tracks={tracks}
              track={selectedTrack}
              codecs={codecOptions}
              codec={codec}
              bitrate={bitrate}
              mode={mode}
              trialCount={trialCount}
              busy={busy}
              progress={progress}
              ffmpegReady={ffmpeg === null || Boolean(ffmpeg.available)}
              onSelectTrack={setTrackId}
              onCodec={setCodec}
              onBitrate={setBitrate}
              onMode={setMode}
              onTrials={setTrialCount}
              onImport={() => void importFile()}
              onStart={() => void start()}
            />
          ) : (
            <Player
              session={session}
              player={player}
              listenSource={listenSource}
              codecs={codecOptions}
              onSource={(source) => void switchSource(source)}
              onPlay={() => void togglePlay()}
              onSeek={(seconds) => void api.seek(seconds)}
              onVote={(choice) => void submitVote(choice)}
              onEnd={() => void endSession()}
            />
          )}
        </main>
      </div>
    </div>
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
                {track.genre ?? track.license ?? "Lossless"}
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
  tracks,
  track,
  codecs,
  codec,
  bitrate,
  mode,
  trialCount,
  busy,
  progress,
  ffmpegReady,
  onSelectTrack,
  onCodec,
  onBitrate,
  onMode,
  onTrials,
  onImport,
  onStart,
}: {
  tracks: Track[];
  track: Track | null;
  codecs: CodecOption[];
  codec: string;
  bitrate: number;
  mode: SessionMode;
  trialCount: number;
  busy: boolean;
  progress: PrepareProgress | null;
  ffmpegReady: boolean;
  onSelectTrack: (id: string) => void;
  onCodec: (id: string) => void;
  onBitrate: (rate: number) => void;
  onMode: (mode: SessionMode) => void;
  onTrials: (n: number) => void;
  onImport: () => void;
  onStart: () => void;
}) {
  const selected = codecs.find((item) => item.id === codec);
  return (
    <div className="setup">
      <p className="eyebrow">New comparison</p>
      <h1>{track?.title ?? "Choose a lossless track"}</h1>
      <p className="lede">
        Both the original and the encode are decoded to the same PCM stream, then
        switched at the same playhead. You are hearing codec artifacts, not player
        differences.
      </p>

      <div className="field">
        <span>Track</span>
        <div className="choices tracks">
          {tracks.length === 0 && (
            <p className="hint">No bundled tracks found yet. Import a FLAC or WAV.</p>
          )}
          {tracks.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === track?.id ? "choice on" : "choice"}
              onClick={() => onSelectTrack(item.id)}
            >
              <strong>{item.title}</strong>
              <em>{item.genre ?? item.source}</em>
            </button>
          ))}
          <button type="button" className="choice ghost-choice" onClick={onImport}>
            Import file…
          </button>
        </div>
      </div>

      <div className="cards">
        <ChoiceRow
          label="Codec"
          value={codec}
          options={codecs.map((item) => ({ value: item.id, label: item.label }))}
          onChange={onCodec}
        />
        <ChoiceRow
          label="Bitrate"
          value={String(bitrate)}
          options={(selected?.bitrates ?? []).map((rate) => ({
            value: String(rate),
            label: `${rate} kbps`,
          }))}
          onChange={(value) => onBitrate(Number(value))}
        />
        <ChoiceRow
          label="Mode"
          value={mode}
          options={[
            { value: "open", label: "Open A/B" },
            { value: "blind", label: "Blind ABX" },
          ]}
          onChange={(value) => onMode(value as SessionMode)}
        />
        <ChoiceRow
          label="Trials"
          value={String(trialCount)}
          disabled={mode === "open"}
          options={[8, 12, 16, 24].map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(value) => onTrials(Number(value))}
        />
      </div>

      <button
        type="button"
        className="primary"
        disabled={!track || busy || !ffmpegReady}
        onClick={onStart}
      >
        {busy ? progress?.message ?? "Preparing…" : "Start listening"}
      </button>
      {busy && progress && <p className="hint">{progress.message}</p>}
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
  onChange,
}: {
  devices: DeviceInfo[];
  value: string;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = devices.find((device) => device.name === value) ?? devices[0];
  return (
    <div className="device">
      <span>Output</span>
      <div className="device-menu">
        <button type="button" className="device-button" onClick={() => setOpen((v) => !v)}>
          {current
            ? `${current.name}${current.isDefault ? " (default)" : ""} · ${current.sampleRate} Hz`
            : "System default"}
        </button>
        {open && (
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
  onSource,
  onPlay,
  onSeek,
  onVote,
  onEnd,
}: {
  session: Session;
  player: PlayerStatus | null;
  listenSource: "a" | "b" | "x";
  codecs: CodecOption[];
  onSource: (source: "a" | "b" | "x") => void;
  onPlay: () => void;
  onSeek: (seconds: number) => void;
  onVote: (choice: "a" | "b") => void;
  onEnd: () => void;
}) {
  const duration = player?.durationSeconds ?? 0;
  const position = player?.positionSeconds ?? 0;
  const open = session.mode === "open";
  const answered = session.currentTrial;
  const remaining = Math.max(0, session.trialCount - answered);

  return (
    <div className="player">
      <div className="player-head">
        <div>
          <p className="eyebrow">
            {open ? "Open A/B" : "Blind ABX"} · {codecLabel(codecs, session.codec)}{" "}
            {session.bitrate} kbps
          </p>
          <h1>{session.trackTitle}</h1>
        </div>
        <button type="button" className="ghost" onClick={onEnd}>
          End session
        </button>
      </div>

      <div className="pads">
        <SourcePad
          letter="A"
          caption={open ? "Lossless" : "Reference A"}
          active={listenSource === "a"}
          onClick={() => onSource("a")}
        />
        <SourcePad
          letter="B"
          caption={open ? `${session.codec.toUpperCase()} ${session.bitrate}` : "Reference B"}
          active={listenSource === "b"}
          onClick={() => onSource("b")}
        />
        {!open && (
          <SourcePad
            letter="X"
            caption="Mystery"
            active={listenSource === "x"}
            onClick={() => onSource("x")}
          />
        )}
      </div>

      <p className="engine">
        {open
          ? `Now playing ${player?.source === "b" ? `${session.codec.toUpperCase()} ${session.bitrate}` : "lossless"} (buffer ${player?.source.toUpperCase() ?? "—"})`
          : `Now playing ${listenSource.toUpperCase()} · engine is reading buffer ${listenSource === "x" ? "X" : (player?.source?.toUpperCase() ?? "—")}`}
        {player && (
          <>
            {" "}
            · A≠B confirmed
            {Number.isFinite(player.diffRms)
              ? ` (Δ RMS ${player.diffRms.toExponential(2)})`
              : ""}
          </>
        )}
        {player && !player.buffersDiffer && " · warning: buffers look identical"}
      </p>

      <div className="transport">
        <button type="button" className="play" onClick={onPlay}>
          {player?.playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(duration, 0.01)}
          step={0.01}
          value={Math.min(position, duration)}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        <span className="clock">
          {formatTime(position)} / {formatTime(duration)}
        </span>
      </div>

      <p className="keys">
        A / B{open ? "" : " / X"} switch · Space play · ← → seek
        {open ? "" : " · 1 / 2 vote X is A or B"}
      </p>

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
                <button type="button" onClick={() => onVote("a")}>
                  X is A
                </button>
                <button type="button" onClick={() => onVote("b")}>
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

function SourcePad({
  letter,
  caption,
  active,
  onClick,
}: {
  letter: string;
  caption: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`pad pad-${letter.toLowerCase()} ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <span className="letter">{letter}</span>
      <span className="caption">{caption}</span>
    </button>
  );
}
