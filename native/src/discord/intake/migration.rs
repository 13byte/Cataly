use std::fs::File;
use std::io::Read as _;
use std::os::unix::fs::MetadataExt as _;
use std::path::Path;

use anyhow::{Context, Result, ensure};
use rustix::fs::{Mode, OFlags, open, openat};
use rustix::io::Errno;
use serde::Deserialize;

use super::Snowflake;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedPosition {
    version: u8,
    channel_id: Snowflake,
    #[serde(rename = "cursor")]
    position: String,
}

pub(super) fn read(dir: Option<&Path>, channel: Snowflake) -> Result<Option<Snowflake>> {
    let Some(dir) = dir else {
        return Ok(None);
    };
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let directory = match open(dir, flags | OFlags::DIRECTORY, Mode::empty()) {
        Ok(fd) => File::from(fd),
        Err(Errno::NOENT) => return Ok(None),
        Err(error) => return Err(error).context("opening the legacy Discord cursor directory"),
    };
    let uid = rustix::process::geteuid().as_raw();
    let meta = directory.metadata()?;
    ensure!(
        meta.uid() == uid && meta.mode().trailing_zeros() >= 6,
        "legacy Discord cursor directory is not private"
    );
    let file = match openat(
        &directory,
        format!("{channel}.json"),
        flags | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => File::from(fd),
        Err(Errno::NOENT) => return Ok(None),
        Err(error) => return Err(error).context("opening the legacy Discord cursor"),
    };
    let meta = file.metadata()?;
    ensure!(
        meta.is_file()
            && meta.uid() == uid
            && meta.mode().trailing_zeros() >= 6
            && meta.nlink() == 1,
        "legacy Discord cursor is not a private regular file"
    );
    let mut bytes = Vec::new();
    file.take(1025).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 1024,
        "legacy Discord cursor exceeded its limit"
    );
    let cursor: SavedPosition =
        serde_json::from_slice(&bytes).context("invalid legacy Discord cursor")?;
    ensure!(
        cursor.version == 1 && cursor.channel_id == channel,
        "legacy Discord cursor does not match the channel"
    );
    Ok(Some(if cursor.position == "0" {
        Snowflake::FLOOR
    } else {
        Snowflake::try_from(cursor.position).map_err(anyhow::Error::msg)?
    }))
}
