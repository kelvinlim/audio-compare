use crate::error::AppResult;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const CACHE_VERSION: &str = "v1";

pub fn file_sha256(path: &Path) -> AppResult<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65_536];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn cache_file_name(hash: &str, codec: &str, bitrate_kbps: u32) -> String {
    let ext = match codec {
        "opus" => "opus",
        _ => "mp3",
    };
    format!("{CACHE_VERSION}_{hash}_{codec}_{bitrate_kbps}.{ext}")
}

pub fn cached_encode_path(
    cache_dir: &Path,
    hash: &str,
    codec: &str,
    bitrate_kbps: u32,
) -> PathBuf {
    cache_dir.join(cache_file_name(hash, codec, bitrate_kbps))
}

#[cfg(test)]
mod tests {
    use super::cache_file_name;

    #[test]
    fn names_include_version_codec_and_rate() {
        assert_eq!(
            cache_file_name("abc123", "mp3", 192),
            "v1_abc123_mp3_192.mp3"
        );
        assert_eq!(
            cache_file_name("abc123", "opus", 64),
            "v1_abc123_opus_64.opus"
        );
    }
}
