use std::path::Path;

use anyhow::{Result, ensure};
use tokio::{
    signal::unix::{SignalKind, signal},
    sync::{mpsc, watch},
};

use super::{
    Options, Snowflake, Transport,
    api::DiscordApi,
    configured_api,
    gateway::{IntakeLink, Link},
    gateway_url,
    intake::{Intake, Poll},
    wake::Wake,
};
use crate::harness::{self, discord::Worker};
use crate::omp::Executable;
pub async fn run(omp: &Executable<'_>, cwd: &Path, options: Options) -> Result<()> {
    let owner = Snowflake::try_from(options.owner).map_err(anyhow::Error::msg)?;
    let channels = allowed_channels(options.channel)?;
    let gateway = gateway_url()?;
    let (api, token) = configured_api()?;
    let bot = bot_profile(&api, owner, options.default_avatar.as_deref()).await?;
    let worker = Worker::new(
        omp,
        harness::Options {
            cwd,
            root: &options.state_dir,
            max_sessions: 1,
        },
        options.gateway,
    )?;
    let (interactions, received) = mpsc::channel(32);
    let wake = Wake::default();
    let (stop_send, stop) = watch::channel(false);
    let mut service = Intake {
        worker,
        transport: Transport {
            api,
            interactions: received,
        },
        bot,
        owner,
        stop,
    };
    let shutdown = shutdown_signal(&stop_send);
    let link = async {
        if options.gateway {
            Link {
                url: &gateway,
                token: &token,
                intake: Some(IntakeLink {
                    channels: &channels,
                    owner,
                    wake: &wake,
                    interactions,
                }),
            }
            .run()
            .await
        } else {
            // Keep the channel alive; no Discord interactions are available in REST mode.
            let _sender = interactions;
            std::future::pending::<Result<()>>().await
        }
    };
    let settings = Poll {
        seconds: options.poll_seconds,
        gateway: options.gateway,
        legacy: options.legacy_cursors.as_deref(),
    };
    let result = {
        let poll = service.run(&channels, &wake, settings);
        tokio::pin!(poll);
        tokio::select! {
            result = &mut poll => result,
            result = shutdown => match result {
                Ok(()) => poll.await,
                Err(error) => Err(error),
            },
            result = link => {
                stop_send.send_replace(true);
                poll.await.and(result)
            }
        }
    };
    service.worker.close_memory().await?;
    result
}

async fn bot_profile(
    api: &DiscordApi,
    owner: Snowflake,
    avatar: Option<&Path>,
) -> Result<Snowflake> {
    let profile = api.identity().await?;
    let bot = profile.user;
    ensure!(
        bot.bot && !bot.system && bot.id != owner,
        "Discord native monitor needs a bot token distinct from its owner"
    );
    api.require_message_content().await?;
    if profile.avatar.is_none()
        && let Some(path) = avatar
        && api.set_default_avatar(path).await.is_err()
    {
        eprintln!("DISCORD_DEFAULT_AVATAR_FAILED");
    }
    Ok(bot.id)
}

fn allowed_channels(values: Vec<String>) -> Result<Vec<Snowflake>> {
    let mut channels = values
        .into_iter()
        .map(Snowflake::try_from)
        .collect::<Result<Vec<_>, _>>()
        .map_err(anyhow::Error::msg)?;
    channels.sort_unstable();
    channels.dedup();
    ensure!(
        channels.len() <= 64,
        "Discord native monitor accepts at most 64 explicit channels"
    );
    Ok(channels)
}

async fn shutdown_signal(stop: &watch::Sender<bool>) -> Result<()> {
    termination().await?;
    stop.send_replace(true);
    Ok(())
}

pub(super) async fn termination() -> Result<()> {
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
    Ok(())
}
