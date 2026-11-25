//! One message that carries files: a multipart request whose nonce Discord enforces, so the single bounded retry of
//! a rate-limited request cannot post a second message.

use anyhow::{Context, Result, ensure};
use reqwest::Method;
use serde_json::{Value, json};

use super::{DiscordApi, Receipt, Snowflake, http::Payload, text_body};

/// Discord takes at most 25 MiB in one message request.
const MAX_REQUEST_BYTES: u64 = 25 * 1024 * 1024;
/// Kept for the JSON part and the part headers. The longest text, a reply and ten files whose names are as long as
/// a path can be need under a third of it, so a request within the file limit never reaches the request limit.
const FRAMING_HEADROOM: u64 = 1024 * 1024;
/// The most bytes the files of one message may have together: the request limit less the framing headroom.
pub(in crate::discord) const MAX_FILE_BYTES_TOGETHER: u64 = MAX_REQUEST_BYTES - FRAMING_HEADROOM;

/// One file of a message: the name Discord shows and the exact bytes.
pub(in crate::discord) struct FilePart<'a> {
    pub(in crate::discord) name: &'a str,
    pub(in crate::discord) bytes: &'a [u8],
}

impl DiscordApi {
    /// Posts `files` with optional `content` as one new message in `channel`, replying to `reference` when given.
    /// The receipt must name this channel and every file with its exact size; a failure after Discord accepted the
    /// request therefore means the message may exist.
    pub(in crate::discord) async fn post_files(
        &self,
        channel: Snowflake,
        reference: Option<Snowflake>,
        content: &str,
        files: &[FilePart<'_>],
        nonce: &str,
    ) -> Result<Receipt> {
        let boundary = format!("cataly-{}", crate::util::uuid()?.replace('-', ""));
        let body = multipart(
            &boundary,
            &files_body(channel, reference, content, files, nonce),
            files,
        );
        let path = format!("channels/{channel}/messages");
        let payload = Payload::Multipart {
            boundary: &boundary,
            body: &body,
        };
        let answer = self
            .request(Method::POST, &path, Some(payload), true)
            .await?;
        let receipt: Receipt = serde_json::from_slice(&answer)
            .context("Discord did not confirm the posted message")?;
        ensure!(
            receipt.channel_id == channel,
            "Discord returned message {} in another channel",
            receipt.id
        );
        ensure!(
            receipt.attachments.len() == files.len()
                && receipt
                    .attachments
                    .iter()
                    .zip(files)
                    .all(|(stored, file)| u64::try_from(file.bytes.len()).ok() == Some(stored.size)),
            "Discord posted message {} without confirming every file",
            receipt.id
        );
        Ok(receipt)
    }
}

/// The JSON part: the text message body without empty content, an enforced nonce, and each file bound by its index.
fn files_body(
    channel: Snowflake,
    reference: Option<Snowflake>,
    content: &str,
    files: &[FilePart<'_>],
    nonce: &str,
) -> Value {
    let mut body = text_body(channel, reference, content);
    if content.is_empty()
        && let Some(fields) = body.as_object_mut()
    {
        fields.remove("content");
    }
    body["nonce"] = json!(nonce);
    body["enforce_nonce"] = json!(true);
    body["attachments"] = files
        .iter()
        .enumerate()
        .map(|(id, file)| json!({ "id": id, "filename": file.name }))
        .collect();
    body
}

/// `multipart/form-data` as Discord reads it: `payload_json`, then one `files[n]` part per file.
fn multipart(boundary: &str, payload: &Value, files: &[FilePart<'_>]) -> Vec<u8> {
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n{payload}\r\n"
    )
    .into_bytes();
    for (index, file) in files.iter().enumerate() {
        // The form-data escapes: a quote or line break in a name cannot end its header early.
        let name = file
            .name
            .replace('"', "%22")
            .replace('\r', "%0D")
            .replace('\n', "%0A");
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"files[{index}]\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(file.bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(raw: &str) -> Snowflake {
        Snowflake::try_from(raw.to_owned()).unwrap()
    }

    #[test]
    fn json_part_binds_files_by_index_under_an_enforced_nonce() {
        let files = [
            FilePart {
                name: "chart.png",
                bytes: b"png",
            },
            FilePart {
                name: "notes.md",
                bytes: b"notes",
            },
        ];
        assert_eq!(
            files_body(id("20"), Some(id("90")), "two files", &files, "abc"),
            json!({
                "content": "two files",
                "allowed_mentions": {"parse": [], "replied_user": false},
                "message_reference": {"message_id": "90", "channel_id": "20", "fail_if_not_exists": true},
                "nonce": "abc",
                "enforce_nonce": true,
                "attachments": [{"id": 0, "filename": "chart.png"}, {"id": 1, "filename": "notes.md"}]
            })
        );
        // Files alone send no empty content, and a plain post carries no reference.
        assert_eq!(
            files_body(id("20"), None, "", &files[..1], "abc"),
            json!({
                "allowed_mentions": {"parse": [], "replied_user": false},
                "nonce": "abc",
                "enforce_nonce": true,
                "attachments": [{"id": 0, "filename": "chart.png"}]
            })
        );
    }

    #[test]
    fn multipart_frames_every_part_and_escapes_names() {
        let files = [
            FilePart {
                name: "a \"b\"\r\n.txt",
                bytes: b"\x00\xff--x\r\n",
            },
            FilePart {
                name: "\u{acb0}\u{acfc}.md",
                bytes: b"second",
            },
        ];
        let body = multipart("B", &json!({"nonce": "n"}), &files);
        let mut expected = b"--B\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n{\"nonce\":\"n\"}\r\n".to_vec();
        expected.extend_from_slice(b"--B\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"a %22b%22%0D%0A.txt\"\r\nContent-Type: application/octet-stream\r\n\r\n\x00\xff--x\r\n\r\n");
        expected.extend_from_slice("--B\r\nContent-Disposition: form-data; name=\"files[1]\"; filename=\"\u{acb0}\u{acfc}.md\"\r\nContent-Type: application/octet-stream\r\n\r\nsecond\r\n".as_bytes());
        expected.extend_from_slice(b"--B--\r\n");
        assert_eq!(body, expected);
    }

    #[test]
    fn framing_of_the_largest_message_stays_inside_its_headroom() {
        // Ten files named with 4095 bytes each, the most a path allows, of the byte that costs most in both
        // parts (a control character: six bytes as JSON, one in the header), under the longest text and a
        // reply in the widest channel.
        let name = "\u{1}".repeat(4095);
        let files: Vec<FilePart<'_>> = (0..10)
            .map(|_| FilePart {
                name: &name,
                bytes: &[],
            })
            .collect();
        let widest = id(&u64::MAX.to_string());
        let payload = files_body(
            widest,
            Some(widest),
            &"\u{1}".repeat(2000),
            &files,
            &"f".repeat(24),
        );
        let boundary = format!("cataly-{}", "f".repeat(32));
        let framing = u64::try_from(multipart(&boundary, &payload, &files).len()).unwrap();
        assert!(
            framing > 256 * 1024 && framing <= FRAMING_HEADROOM / 3,
            "{framing}"
        );
        // So the largest admitted files always leave the request under Discord's limit.
        assert_eq!(MAX_FILE_BYTES_TOGETHER, 24 * 1024 * 1024);
        assert!(MAX_FILE_BYTES_TOGETHER + framing < MAX_REQUEST_BYTES);
    }
}
