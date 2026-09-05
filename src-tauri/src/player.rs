use crate::error::{AppError, AppResult};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Sample, SampleFormat, SizedSample, StreamConfig};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, RwLock};

const CHANNELS: usize = 2;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    A,
    B,
}

impl Source {
    fn as_index(self) -> usize {
        match self {
            Source::A => 0,
            Source::B => 1,
        }
    }

    fn from_index(index: u8) -> Self {
        if index == 0 {
            Source::A
        } else {
            Source::B
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub name: String,
    pub is_default: bool,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStatus {
    pub playing: bool,
    pub source: Source,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub loaded: bool,
    pub buffers_differ: bool,
    pub diff_rms: f64,
}

struct Buffers {
    a: Arc<Vec<f32>>,
    b: Arc<Vec<f32>>,
    frame_len: usize,
}

struct Shared {
    buffers: RwLock<Option<Buffers>>,
    playhead: AtomicUsize,
    source: AtomicU8,
    playing: AtomicBool,
    sample_rate: AtomicU32,
    diff_rms_bits: AtomicU32,
}

enum Command {
    RebuildStream,
    SetDevice(Option<String>),
}

#[derive(Clone)]
pub struct PlayerHandle {
    tx: Sender<Command>,
    shared: Arc<Shared>,
    device_name: Arc<Mutex<Option<String>>>,
}

impl PlayerHandle {
    pub fn start() -> Self {
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            buffers: RwLock::new(None),
            playhead: AtomicUsize::new(0),
            source: AtomicU8::new(0),
            playing: AtomicBool::new(false),
            sample_rate: AtomicU32::new(48_000),
            diff_rms_bits: AtomicU32::new(0.0f32.to_bits()),
        });
        let device_name = Arc::new(Mutex::new(None));
        let thread_shared = shared.clone();
        std::thread::Builder::new()
            .name("audio-engine".into())
            .spawn(move || audio_thread(rx, thread_shared))
            .expect("failed to start audio engine thread");

        Self {
            tx,
            shared,
            device_name,
        }
    }

    pub fn load(&self, a: Vec<f32>, b: Vec<f32>, sample_rate: u32) -> AppResult<f64> {
        let diff = pcm_diff_rms(&a, &b);
        if !buffers_are_distinct(diff) {
            return Err(AppError::msg(
                "A and B decoded to the same PCM — the lossy encode may have failed",
            ));
        }
        let frame_len = a.len().min(b.len()) / CHANNELS;
        *self.shared.buffers.write().unwrap() = Some(Buffers {
            a: Arc::new(a),
            b: Arc::new(b),
            frame_len,
        });
        self.shared
            .sample_rate
            .store(sample_rate, Ordering::Release);
        self.shared.playhead.store(0, Ordering::Release);
        self.shared
            .diff_rms_bits
            .store((diff as f32).to_bits(), Ordering::Release);
        self.tx
            .send(Command::RebuildStream)
            .map_err(|_| AppError::msg("audio engine is not running"))?;
        Ok(diff)
    }

    pub fn play(&self) -> AppResult<()> {
        self.shared.playing.store(true, Ordering::Release);
        Ok(())
    }

    pub fn pause(&self) -> AppResult<()> {
        self.shared.playing.store(false, Ordering::Release);
        Ok(())
    }

    pub fn seek(&self, seconds: f64) -> AppResult<()> {
        let rate = self.shared.sample_rate.load(Ordering::Acquire).max(1) as f64;
        let frame_len = self
            .shared
            .buffers
            .read()
            .unwrap()
            .as_ref()
            .map(|b| b.frame_len)
            .unwrap_or(0);
        let frame = (seconds.max(0.0) * rate) as usize;
        self.shared.playhead.store(
            frame.min(frame_len.saturating_sub(1)),
            Ordering::Release,
        );
        Ok(())
    }

    pub fn set_source(&self, source: Source) -> AppResult<()> {
        // Apply immediately so the render callback sees the new buffer on
        // the next sample, even if the audio thread is busy rebuilding a stream.
        self.shared
            .source
            .store(source.as_index() as u8, Ordering::Release);
        Ok(())
    }

    pub fn set_device(&self, name: Option<String>) -> AppResult<()> {
        *self.device_name.lock().unwrap() = name.clone();
        self.tx
            .send(Command::SetDevice(name))
            .map_err(|_| AppError::msg("audio engine is not running"))
    }

    pub fn selected_device(&self) -> Option<String> {
        self.device_name.lock().unwrap().clone()
    }

    pub fn status(&self) -> PlayerStatus {
        let loaded = self.shared.buffers.read().unwrap().is_some();
        let sample_rate = self.shared.sample_rate.load(Ordering::Relaxed).max(1);
        let frame_len = self
            .shared
            .buffers
            .read()
            .unwrap()
            .as_ref()
            .map(|b| b.frame_len)
            .unwrap_or(0);
        let position = self.shared.playhead.load(Ordering::Relaxed);
        let diff_rms = f32::from_bits(self.shared.diff_rms_bits.load(Ordering::Acquire)) as f64;
        PlayerStatus {
            playing: self.shared.playing.load(Ordering::Acquire),
            source: Source::from_index(self.shared.source.load(Ordering::Acquire)),
            position_seconds: position as f64 / sample_rate as f64,
            duration_seconds: frame_len as f64 / sample_rate as f64,
            sample_rate,
            loaded,
            buffers_differ: buffers_are_distinct(diff_rms),
            diff_rms,
        }
    }
}

pub fn list_devices_infallible() -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let default_device = host.default_output_device();
    let default_name = default_device.as_ref().and_then(|device| device.name().ok());
    let mut devices = Vec::new();

    if let Some(device) = default_device {
        if let Some(info) = device_info(&device, true) {
            devices.push(info);
        }
    }

    if let Ok(outputs) = host.output_devices() {
        for device in outputs {
            let Ok(name) = device.name() else {
                continue;
            };
            if devices.iter().any(|item| item.name == name) {
                continue;
            }
            if let Some(info) = device_info(&device, default_name.as_deref() == Some(name.as_str()))
            {
                devices.push(info);
            }
        }
    }

    if devices.is_empty() {
        devices.push(DeviceInfo {
            name: "System default".into(),
            is_default: true,
            sample_rate: 48_000,
            channels: 2,
        });
    }
    devices
}

fn device_info(device: &Device, is_default: bool) -> Option<DeviceInfo> {
    let name = device.name().ok()?;
    let config = device.default_output_config().ok();
    Some(DeviceInfo {
        is_default,
        sample_rate: config.as_ref().map(|c| c.sample_rate().0).unwrap_or(48_000),
        channels: config.as_ref().map(|c| c.channels()).unwrap_or(2),
        name,
    })
}

pub fn device_sample_rate(preferred: Option<&str>) -> u32 {
    resolve_device(preferred)
        .and_then(|device| device.default_output_config().ok())
        .map(|config| config.sample_rate().0)
        .unwrap_or(48_000)
}

fn resolve_device(preferred: Option<&str>) -> Option<Device> {
    let host = cpal::default_host();
    if let Some(name) = preferred {
        if let Ok(mut devices) = host.output_devices() {
            if let Some(found) = devices.find(|device| device.name().ok().as_deref() == Some(name))
            {
                return Some(found);
            }
        }
    }
    host.default_output_device()
}

#[allow(unused_assignments, unused_variables)]
fn audio_thread(rx: mpsc::Receiver<Command>, shared: Arc<Shared>) {
    let mut preferred: Option<String> = None;
    // Held so the cpal stream is not dropped; assignment replaces the previous device.
    #[allow(unused_assignments, unused_variables)]
    let mut stream = build_stream(&preferred, &shared);

    while let Ok(command) = rx.recv() {
        match command {
            Command::RebuildStream => {
                stream = build_stream(&preferred, &shared);
            }
            Command::SetDevice(name) => {
                preferred = name;
                stream = build_stream(&preferred, &shared);
            }
        }
    }
}

fn build_stream(preferred: &Option<String>, shared: &Arc<Shared>) -> Option<cpal::Stream> {
    let device = resolve_device(preferred.as_deref())?;
    let supported = device.default_output_config().ok()?;
    let config: StreamConfig = supported.clone().into();
    let format = supported.sample_format();
    let result = match format {
        SampleFormat::F32 => start_stream::<f32>(&device, &config, shared),
        SampleFormat::I16 => start_stream::<i16>(&device, &config, shared),
        SampleFormat::U16 => start_stream::<u16>(&device, &config, shared),
        SampleFormat::I8 => start_stream::<i8>(&device, &config, shared),
        SampleFormat::U8 => start_stream::<u8>(&device, &config, shared),
        SampleFormat::I32 => start_stream::<i32>(&device, &config, shared),
        SampleFormat::U32 => start_stream::<u32>(&device, &config, shared),
        SampleFormat::F64 => start_stream::<f64>(&device, &config, shared),
        _ => start_stream::<f32>(&device, &config, shared),
    };
    match result {
        Ok(stream) => {
            let _ = stream.play();
            Some(stream)
        }
        Err(err) => {
            eprintln!("failed to open audio stream: {err}");
            None
        }
    }
}

fn start_stream<T>(
    device: &Device,
    config: &StreamConfig,
    shared: &Arc<Shared>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample + FromSample,
{
    let shared = shared.clone();
    let out_channels = config.channels as usize;
    device.build_output_stream(
        config,
        move |output: &mut [T], _| write_frames(output, out_channels, &shared),
        |err| eprintln!("audio stream error: {err}"),
        None,
    )
}

fn write_frames<T: FromSample>(output: &mut [T], out_channels: usize, shared: &Shared) {
    let Ok(guard) = shared.buffers.read() else {
        silence(output);
        return;
    };
    let Some(buffers) = guard.as_ref() else {
        silence(output);
        return;
    };
    if buffers.frame_len == 0 {
        silence(output);
        return;
    }

    let frame_len = buffers.frame_len;
    let mut pos = shared.playhead.load(Ordering::Acquire);
    let mut playing = false;

    for frame in output.chunks_mut(out_channels.max(1)) {
        playing = shared.playing.load(Ordering::Acquire);
        if !playing {
            for sample in frame.iter_mut() {
                *sample = T::from_f32(0.0);
            }
            continue;
        }
        // Re-read every frame so A/B/X takes effect on the next sample,
        // not at the end of a 5–10 ms callback.
        let source = shared.source.load(Ordering::Acquire) as usize;
        let data = if source == 0 {
            buffers.a.as_slice()
        } else {
            buffers.b.as_slice()
        };
        if pos >= frame_len {
            pos = 0;
        }
        let idx = pos * CHANNELS;
        let (left, right) = if idx + 1 < data.len() {
            (data[idx], data[idx + 1])
        } else {
            (0.0, 0.0)
        };
        if out_channels == 1 {
            frame[0] = T::from_f32((left + right) * 0.5);
        } else {
            frame[0] = T::from_f32(left);
            if out_channels > 1 {
                frame[1] = T::from_f32(right);
            }
            for extra in frame.iter_mut().skip(2) {
                *extra = T::from_f32(0.0);
            }
        }
        pos += 1;
    }

    if playing {
        shared
            .playhead
            .store(pos % frame_len.max(1), Ordering::Release);
    }
}

pub fn pcm_diff_rms(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len().min(b.len());
    if n == 0 {
        return 0.0;
    }
    let mut sum = 0.0_f64;
    for i in 0..n {
        let delta = f64::from(a[i] - b[i]);
        sum += delta * delta;
    }
    (sum / n as f64).sqrt()
}

fn buffers_are_distinct(diff_rms: f64) -> bool {
    diff_rms > 1e-6
}

#[cfg(test)]
mod tests {
    use super::{buffers_are_distinct, pcm_diff_rms};

    #[test]
    fn identical_buffers_are_rejected() {
        let a = vec![0.1_f32, -0.2, 0.3, 0.0];
        assert!(!buffers_are_distinct(pcm_diff_rms(&a, &a)));
    }

    #[test]
    fn different_buffers_are_accepted() {
        let a = vec![0.1_f32, -0.2, 0.3, 0.0];
        let b = vec![0.1_f32, 0.2, 0.3, 0.0];
        let diff = pcm_diff_rms(&a, &b);
        assert!(buffers_are_distinct(diff));
        assert!(diff > 0.1);
    }
}

fn silence<T: FromSample>(output: &mut [T]) {
    for sample in output.iter_mut() {
        *sample = T::from_f32(0.0);
    }
}

trait FromSample {
    fn from_f32(value: f32) -> Self;
}

impl FromSample for f32 {
    fn from_f32(value: f32) -> Self {
        value
    }
}

impl FromSample for f64 {
    fn from_f32(value: f32) -> Self {
        value as f64
    }
}

impl FromSample for i16 {
    fn from_f32(value: f32) -> Self {
        i16::from_sample(value)
    }
}

impl FromSample for i8 {
    fn from_f32(value: f32) -> Self {
        i8::from_sample(value)
    }
}

impl FromSample for i32 {
    fn from_f32(value: f32) -> Self {
        i32::from_sample(value)
    }
}

impl FromSample for u16 {
    fn from_f32(value: f32) -> Self {
        u16::from_sample(value)
    }
}

impl FromSample for u8 {
    fn from_f32(value: f32) -> Self {
        u8::from_sample(value)
    }
}

impl FromSample for u32 {
    fn from_f32(value: f32) -> Self {
        u32::from_sample(value)
    }
}
