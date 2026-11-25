//! Files a caller admitted for one Discord message. Each is named with the size and SHA-256 its path gate recorded;
//! only bytes that still match are sent, and every refusal here happens before any request.

use std::fs::File;
use std::io::Read as _;
use std::path::PathBuf;

use anyhow::{Context, Result, ensure};
use rustix::fs::{Mode, OFlags, open};
use sha2::{Digest as _, Sha256};

use crate::discord::api::MAX_FILE_BYTES_TOGETHER as MAX_TOTAL_BYTES;

/// Discord's documented limits: 10 attachments per message (JSON error 30015,
/// <https://docs.discord.com/developers/topics/opcodes-and-status-codes#json>) and 20 MiB per file
/// (<https://docs.discord.com/developers/reference#uploading-files>). Together the files may have 24 MiB: its
/// 25 MiB request limit less the headroom kept for the text and the multipart framing.
const MAX_FILES: usize = 10;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

/// `<sha256>:<bytes>:<path>`: an absolute path with the identity its caller admitted.
#[derive(Clone, Debug)]
pub struct Admitted {
    sha256: String,
    size: u64,
    path: PathBuf,
}

pub fn parse(raw: &str) -> Result<Admitted, &'static str> {
    let mut fields = raw.splitn(3, ':');
    let (Some(sha256), Some(size), Some(path)) = (fields.next(), fields.next(), fields.next())
    else {
        return Err("expected <sha256>:<bytes>:<path>");
    };
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("the SHA-256 must be 64 lowercase hexadecimal digits");
    }
    let size = size
        .parse::<u64>()
        .ok()
        .filter(|bytes| bytes.to_string() == size)
        .ok_or("the size must be a whole number of bytes")?;
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("the path must be absolute");
    }
    Ok(Admitted {
        sha256: sha256.to_owned(),
        size,
        path,
    })
}

/// One verified file: the name Discord shows, its exact bytes and their SHA-256.
pub(super) struct Upload {
    pub(super) name: String,
    pub(super) bytes: Vec<u8>,
    pub(super) sha256: String,
}

/// Reads every admitted file and keeps it only when its bytes have the admitted size and SHA-256.
pub(super) fn load(files: &[Admitted]) -> Result<Vec<Upload>> {
    ensure!(
        files.len() <= MAX_FILES,
        "Discord takes at most {MAX_FILES} files in one message"
    );
    let mut total = 0_u64;
    let mut uploads = Vec::with_capacity(files.len());
    for file in files {
        let shown = file.path.display();
        ensure!(file.size > 0, "Discord file {shown} is empty");
        ensure!(
            file.size <= MAX_FILE_BYTES,
            "Discord file {shown} exceeds {MAX_FILE_BYTES} bytes"
        );
        total += file.size;
        ensure!(
            total <= MAX_TOTAL_BYTES,
            "Discord files exceed {MAX_TOTAL_BYTES} bytes in one message"
        );
        let name = file
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .with_context(|| format!("Discord file {shown} has no usable name"))?;
        let bytes = read(file)
            .with_context(|| format!("Discord file {shown} cannot be read as admitted"))?;
        ensure!(
            u64::try_from(bytes.len()).ok() == Some(file.size)
                && crate::util::hex(&Sha256::digest(&bytes)) == file.sha256,
            "Discord file {shown} changed after it was admitted; nothing was sent"
        );
        uploads.push(Upload {
            name: name.to_owned(),
            bytes,
            sha256: file.sha256.clone(),
        });
    }
    Ok(uploads)
}

/// At most one byte more than admitted, from a regular file opened without blocking on a FIFO.
fn read(file: &Admitted) -> Result<Vec<u8>> {
    let flags = OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC;
    let opened = File::from(open(&file.path, flags, Mode::empty())?);
    ensure!(opened.metadata()?.is_file(), "not a regular file");
    let mut bytes = Vec::new();
    opened.take(file.size + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    const HELLO: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cataly-send-files-{}-{}",
            std::process::id(),
            crate::util::uuid().unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn admitted(sha256: &str, size: u64, path: &Path) -> Admitted {
        parse(&format!("{sha256}:{size}:{}", path.display())).unwrap()
    }

    #[test]
    fn parses_only_an_exact_identity_with_an_absolute_path() {
        let file = parse(&format!("{HELLO}:5:/srv/reports/a:b.txt")).unwrap();
        assert_eq!(
            (file.sha256.as_str(), file.size, file.path.as_path()),
            (HELLO, 5, Path::new("/srv/reports/a:b.txt"))
        );
        for raw in [
            "/srv/reports/a.txt".to_owned(),
            format!("{HELLO}:5"),
            format!("{}:5:/a.txt", HELLO.to_uppercase()),
            format!("{}:5:/a.txt", &HELLO[1..]),
            format!("{HELLO}:05:/a.txt"),
            format!("{HELLO}:+5:/a.txt"),
            format!("{HELLO}:5:relative.txt"),
            format!("{HELLO}:5:"),
        ] {
            assert!(parse(&raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn loads_only_bytes_that_match_the_admitted_identity() {
        let path = scratch("hello.txt");
        std::fs::write(&path, "hello").unwrap();
        let loaded = load(&[admitted(HELLO, 5, &path)]).unwrap();
        assert_eq!(
            (
                loaded[0].name.as_str(),
                loaded[0].bytes.as_slice(),
                loaded[0].sha256.as_str()
            ),
            ("hello.txt", b"hello".as_slice(), HELLO)
        );
        let other = HELLO.replace('2', "3");
        for (file, reason) in [
            (admitted(&other, 5, &path), "changed after it was admitted"),
            (admitted(HELLO, 4, &path), "changed after it was admitted"),
            (admitted(HELLO, 6, &path), "changed after it was admitted"),
            (admitted(HELLO, 0, &path), "is empty"),
            (admitted(HELLO, MAX_FILE_BYTES + 1, &path), "exceeds"),
            (
                admitted(HELLO, 5, path.parent().unwrap()),
                "cannot be read as admitted",
            ),
            (
                admitted(HELLO, 5, &path.with_extension("missing")),
                "cannot be read as admitted",
            ),
        ] {
            let error = load(&[file]).err().expect(reason);
            assert!(format!("{error:#}").contains(reason), "{error:#}");
        }
        std::fs::write(&path, "hullo").unwrap();
        assert!(load(&[admitted(HELLO, 5, &path)]).is_err());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn refuses_more_files_or_bytes_than_one_message_carries() {
        let path = scratch("full.bin");
        let sized = |name: &str, bytes: u64| {
            let path = path.with_file_name(name);
            let block = vec![7_u8; usize::try_from(bytes).unwrap()];
            std::fs::write(&path, &block).unwrap();
            admitted(&crate::util::hex(&Sha256::digest(&block)), bytes, &path)
        };
        // Exactly the per-file limit and exactly the limit for all files together are admitted.
        let full = sized("full.bin", MAX_FILE_BYTES);
        let rest = sized("rest.bin", MAX_TOTAL_BYTES - MAX_FILE_BYTES);
        let loaded = load(&[full.clone(), rest.clone()]).unwrap();
        let total: usize = loaded.iter().map(|file| file.bytes.len()).sum();
        assert_eq!(u64::try_from(total).unwrap(), MAX_TOTAL_BYTES);
        // One byte more, per file or together, is refused from the admitted sizes alone.
        let beyond = |file: &Admitted| Admitted {
            size: file.size + 1,
            ..file.clone()
        };
        let error = load(&[beyond(&full)]).err().unwrap();
        assert!(
            error.to_string().contains("exceeds 20971520 bytes"),
            "{error}"
        );
        let error = load(&[full, beyond(&rest)]).err().unwrap();
        assert!(
            error
                .to_string()
                .contains("exceed 25165824 bytes in one message"),
            "{error}"
        );
        let error = load(&vec![rest; MAX_FILES + 1]).err().unwrap();
        assert!(error.to_string().contains("at most 10 files"), "{error}");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
