import { spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

/** Pinned ffmpeg-static release: GPL builds with libmp3lame and libopus. */
const RELEASE = "b6.1.1";
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`;

const TARGETS = {
  "aarch64-apple-darwin": {
    asset: "ffmpeg-darwin-arm64.gz",
    license: "darwin-arm64.LICENSE",
    exe: false,
  },
  "x86_64-unknown-linux-gnu": {
    asset: "ffmpeg-linux-x64.gz",
    license: "linux-x64.LICENSE",
    exe: false,
  },
  "x86_64-pc-windows-msvc": {
    asset: "ffmpeg-win32-x64.gz",
    license: "win32-x64.LICENSE",
    exe: true,
  },
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "src-tauri", "binaries");
const force = process.argv.includes("--force");

function hostTarget() {
  const override = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.PREPARE_FFMPEG_TARGET;
  if (override) {
    return override;
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "x86_64-apple-darwin";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }
  throw new Error(
    `No bundled ffmpeg for ${process.platform}/${process.arch}. Set PREPARE_FFMPEG_TARGET to a supported triple.`,
  );
}

async function download(url, dest, gunzip) {
  const response = await fetch(url, {
    headers: { "User-Agent": "audio-compare-prepare-ffmpeg" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`download failed ${response.status} ${url}`);
  }
  const body = Readable.fromWeb(response.body);
  const out = createWriteStream(dest);
  if (gunzip) {
    await pipeline(body, createGunzip(), out);
  } else {
    await pipeline(body, out);
  }
}

function canRunSidecar(target) {
  return (
    (target === "aarch64-apple-darwin" && process.platform === "darwin" && process.arch === "arm64") ||
    (target === "x86_64-unknown-linux-gnu" && process.platform === "linux" && process.arch === "x64") ||
    (target === "x86_64-pc-windows-msvc" && process.platform === "win32" && process.arch === "x64")
  );
}

function verifyEncoders(bin) {
  const result = spawnSync(bin, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const missing = [];
  if (!text.includes("libmp3lame")) {
    missing.push("libmp3lame");
  }
  if (!text.includes("libopus")) {
    missing.push("libopus");
  }
  if (missing.length > 0) {
    throw new Error(`${bin} is missing encoders: ${missing.join(", ")}`);
  }
}

const target = hostTarget();
const spec = TARGETS[target];
if (!spec) {
  throw new Error(`No ffmpeg download mapped for ${target}`);
}

mkdirSync(destDir, { recursive: true });
const dest = join(destDir, spec.exe ? `ffmpeg-${target}.exe` : `ffmpeg-${target}`);
const licenseDest = join(destDir, "FFMPEG-LICENSE");

if (existsSync(dest) && !force) {
  if (!existsSync(licenseDest)) {
    await download(`${BASE}/${spec.license}`, licenseDest, false);
  }
  if (canRunSidecar(target)) {
    verifyEncoders(dest);
  }
  console.log(`using existing ${dest}`);
  process.exit(0);
}

console.log(`downloading ffmpeg ${RELEASE} for ${target}`);
await download(`${BASE}/${spec.asset}`, dest, true);
if (!spec.exe) {
  chmodSync(dest, 0o755);
}
if (process.platform === "darwin") {
  spawnSync("xattr", ["-d", "com.apple.quarantine", dest]);
}
await download(`${BASE}/${spec.license}`, licenseDest, false);

if (canRunSidecar(target)) {
  verifyEncoders(dest);
}

console.log(`wrote ${dest}`);
