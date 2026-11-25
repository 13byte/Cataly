use std::process::ExitCode;

use anyhow::{Context, Result, bail, ensure};
use clap::Args;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt as _;

use super::{
    Snowflake,
    api::{DiscordApi, FilePart, RestStatus},
};
use crate::discord_split as split;

mod files;

/// Exit status of a file delivery that may exist but was not confirmed: inspect the destination, never resend.
const UNCONFIRMED: u8 = 3;

#[derive(Args, Debug)]
pub struct SendOptions {
    /// Exact channel ID or a unique name in `CATALY_DISCORD_GUILD_ID`.
    #[arg(long, required_unless_present = "thread", conflicts_with = "thread")]
    to: Option<String>,
    /// Exact destination thread ID.
    #[arg(long, value_parser = parse_id)]
    thread: Option<Snowflake>,
    /// Reply to this exact message in the destination.
    #[arg(long, value_parser = parse_id, conflicts_with = "edit")]
    reply: Option<Snowflake>,
    /// Replace one existing message instead of creating a new one.
    #[arg(long, value_parser = parse_id)]
    edit: Option<Snowflake>,
    /// Attach a file whose bytes have exactly this SHA-256 and size (repeatable, at most 10 in one new message).
    #[arg(
        long = "file",
        value_name = "SHA256:BYTES:PATH",
        value_parser = files::parse,
        conflicts_with = "edit"
    )]
    files: Vec<files::Admitted>,
}

fn parse_id(raw: &str) -> Result<Snowflake, &'static str> {
    Snowflake::try_from(raw.to_owned())
}

#[derive(Deserialize)]
struct Channel {
    id: Snowflake,
    #[serde(rename = "type")]
    kind: u8,
    name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Delivery {
    channel: Snowflake,
    ids: Vec<Snowflake>,
    reply_confirmed: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<Attachment>,
}

/// Discord's receipt for one file, with the SHA-256 of the bytes that were sent.
#[derive(Serialize)]
struct Attachment {
    id: Snowflake,
    filename: String,
    size: u64,
    sha256: String,
}

/// Whether a failed file post may still have created its message: an answer that was lost, could not be read or
/// does not confirm the files, or a server-side failure. Every other HTTP status is a rejection.
fn unconfirmed(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<RestStatus>()
        .is_none_or(|rest| rest.status == 408 || rest.status >= 500)
}

pub async fn send(options: SendOptions) -> Result<ExitCode> {
    const LIMIT: u64 = 256 * 1024;
    let mut input = Vec::new();
    tokio::io::stdin()
        .take(LIMIT + 1)
        .read_to_end(&mut input)
        .await?;
    ensure!(
        u64::try_from(input.len())? <= LIMIT,
        "Discord text exceeds 256 KiB"
    );
    let text = std::str::from_utf8(&input)?.trim();
    ensure!(
        !text.is_empty() || !options.files.is_empty(),
        "Discord text is empty"
    );
    ensure!(
        !text.contains("$("),
        "Discord text contains a shell substitution marker"
    );
    let fits = text.encode_utf16().take(split::LIMIT + 1).count() <= split::LIMIT;
    ensure!(
        options.edit.is_none() || fits,
        "--edit text exceeds 2000 UTF-16 code units"
    );
    // Text beside files stays in their one message, so it is never split.
    ensure!(
        options.files.is_empty() || fits,
        "--file text exceeds 2000 UTF-16 code units"
    );
    let (api, _) = super::configured_api()?;
    // Every file is read and verified before the first request.
    let uploads = files::load(&options.files)?;
    let channel = resolve(&api, &options).await?;
    let mut delivery = Delivery {
        channel,
        ids: Vec::new(),
        reply_confirmed: false,
        attachments: Vec::new(),
    };
    if let Some(message) = options.edit {
        api.edit_text(channel, message, text).await?;
    } else if !uploads.is_empty() {
        let parts: Vec<FilePart<'_>> = uploads
            .iter()
            .map(|file| FilePart {
                name: &file.name,
                bytes: &file.bytes,
            })
            .collect();
        let nonce = crate::util::uuid()?.replace('-', "");
        let posted = api
            .post_files(channel, options.reply, text, &parts, &nonce[..24])
            .await;
        let sent = match posted {
            Ok(sent) => sent,
            Err(error) if unconfirmed(&error) => {
                eprintln!(
                    "Discord file delivery was not confirmed: {error:#}. The message may exist: inspect the destination and do not resend."
                );
                return Ok(ExitCode::from(UNCONFIRMED));
            }
            Err(error) => {
                return Err(error.context("Discord rejected the file message; nothing was posted"));
            }
        };
        delivery.reply_confirmed = options
            .reply
            .is_some_and(|reference| sent.confirms_reply(channel, reference));
        delivery.ids.push(sent.id);
        delivery.attachments = sent
            .attachments
            .into_iter()
            .zip(uploads)
            .map(|(stored, file)| Attachment {
                id: stored.id,
                filename: stored.filename,
                size: stored.size,
                sha256: file.sha256,
            })
            .collect();
    } else {
        for (index, part) in split::partition(text).into_iter().enumerate() {
            let reference = if index == 0 { options.reply } else { None };
            let sent = api.post_text(channel, reference, &part).await.with_context(|| {
                let known = delivery.ids.iter().map(ToString::to_string).collect::<Vec<_>>().join(" ");
                format!("Discord delivery stopped at part {}; confirmed IDs: [{}]. Inspect the destination before retrying", index + 1, known)
            })?;
            delivery.ids.push(sent.id);
            if let Some(reference) = reference {
                delivery.reply_confirmed = sent.confirms_reply(channel, reference);
            }
        }
    }
    println!("{}", serde_json::to_string(&delivery)?);
    Ok(ExitCode::SUCCESS)
}

async fn resolve(api: &DiscordApi, options: &SendOptions) -> Result<Snowflake> {
    if let Some(thread) = options.thread {
        return Ok(thread);
    }
    let to = options
        .to
        .as_deref()
        .context("Discord destination is missing")?;
    ensure!(!to.is_empty(), "Discord destination is empty");
    let channel = if to.bytes().all(|byte| byte.is_ascii_digit()) {
        let id = parse_id(to).map_err(anyhow::Error::msg)?;
        let channel: Channel = api.get(&format!("channels/{id}")).await?;
        ensure!(channel.id == id, "Discord returned another channel");
        channel
    } else {
        let guild = std::env::var("CATALY_DISCORD_GUILD_ID")
            .context("set CATALY_DISCORD_GUILD_ID to look up a channel name")?;
        let guild = parse_id(&guild).map_err(anyhow::Error::msg)?;
        let name = to.strip_prefix('#').unwrap_or(to);
        let channels: Vec<Channel> = api.get(&format!("guilds/{guild}/channels")).await?;
        let mut hits = channels
            .into_iter()
            .filter(|channel| channel.name.as_deref() == Some(name));
        let Some(channel) = hits.next() else {
            bail!("No channel matched that name in the configured Discord guild")
        };
        ensure!(
            hits.next().is_none(),
            "More than one channel matched that name in the configured Discord guild"
        );
        channel
    };
    ensure!(
        !matches!(channel.kind, 15 | 16),
        "Discord forum/media channels require an explicit thread"
    );
    Ok(channel.id)
}
