use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use tokio::{
    sync::watch,
    time::{MissedTickBehavior, interval},
};

use super::{Snowflake, Transport, wake::Wake};
use crate::harness::discord::{Origin, Worker};
mod migration;

const PAGE: u8 = 100;
const PAGE_LIMIT: usize = 20;

pub(super) struct Poll<'a> {
    pub(super) seconds: u64,
    pub(super) gateway: bool,
    pub(super) legacy: Option<&'a Path>,
}

pub(super) struct Intake<'a, 'b> {
    pub(super) worker: Worker<'a, 'b>,
    pub(super) transport: Transport,
    pub(super) bot: Snowflake,
    pub(super) owner: Snowflake,
    pub(super) stop: watch::Receiver<bool>,
}

struct Backlog {
    highest: Snowflake,
    requests: Vec<(Snowflake, String)>,
}

impl Intake<'_, '_> {
    pub(super) async fn run(
        &mut self,
        channels: &[Snowflake],
        wake: &Wake,
        settings: Poll<'_>,
    ) -> Result<()> {
        let Poll {
            seconds: poll_seconds,
            gateway,
            legacy,
        } = settings;
        for &channel in channels {
            let origin = self.origin(channel, Snowflake::FLOOR);
            if self.worker.cursor(origin)?.is_none() {
                let latest = if let Some(cursor) = migration::read(legacy, channel)? {
                    cursor
                } else {
                    let history = self.transport.api.history(channel, None, 1).await?;
                    history
                        .first()
                        .map_or(Snowflake::FLOOR, |message| message.id)
                };
                self.worker.advance(self.origin(channel, latest))?;
            }
        }
        println!(
            "INBOUND_READY discord owner={} bot={} mode=rust-{}",
            self.owner,
            self.bot,
            if gateway { "gateway" } else { "rest" }
        );
        let mut ticks = interval(Duration::from_secs(if gateway {
            30
        } else {
            poll_seconds.max(1)
        }));
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            let pending = tokio::select! {
                biased;
                () = super::stopped(&mut self.stop) => return Ok(()),
                Some(event) = self.transport.interaction() => {
                    // Expired or replayed cards are never forwarded to OMP while no turn is pending.
                    if self.transport.callback(&event, false).await.is_err() {
                        eprintln!("DISCORD_EXPIRED_INTERACTION_CALLBACK_FAILED");
                    }
                    continue;
                }
                _ = ticks.tick() => {
                    wake.take();
                    Wake::ALL
                }
                pending = wake.receive(), if gateway => pending,
            };
            'channels: for (index, &channel) in channels.iter().enumerate() {
                if pending & (1 << index) == 0 {
                    continue;
                }
                let Some(cursor) = self.worker.cursor(self.origin(channel, Snowflake::FLOOR))?
                else {
                    anyhow::bail!("Discord cursor disappeared during intake");
                };
                let backlog = match self.backfill(channel, cursor).await {
                    Ok(backlog) => backlog,
                    Err(error) if gateway || poll_seconds > 0 => {
                        eprintln!("DISCORD_INTAKE_HELD channel={channel}: {error:#}");
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let mut committed = cursor;
                for (id, text) in backlog.requests {
                    if *self.stop.borrow() {
                        return Ok(());
                    }
                    let origin = self.origin(channel, id);
                    match self
                        .worker
                        .run_message(&mut self.transport, origin, text.trim(), &mut self.stop)
                        .await
                    {
                        Ok(true) => {}
                        Ok(false) => return Ok(()),
                        Err(error) if gateway || poll_seconds > 0 => {
                            eprintln!(
                                "DISCORD_LANE_HELD channel={channel} request={id}: {error:#}"
                            );
                            continue 'channels;
                        }
                        Err(error) => return Err(error),
                    }
                    self.worker.advance(origin)?;
                    committed = id;
                }
                if backlog.highest > committed {
                    self.worker.advance(self.origin(channel, backlog.highest))?;
                }
            }
            if !gateway && poll_seconds == 0 {
                return Ok(());
            }
        }
    }

    const fn origin(&self, channel: Snowflake, message: Snowflake) -> Origin {
        Origin {
            bot: self.bot,
            owner: self.owner,
            channel,
            message,
        }
    }

    async fn backfill(&self, channel: Snowflake, cursor: Snowflake) -> Result<Backlog> {
        let mut batch = Backlog {
            highest: cursor,
            requests: Vec::new(),
        };
        let mut bytes = 0usize;
        let mut before = None;
        for _ in 0..PAGE_LIMIT {
            let page = self.transport.api.history(channel, before, PAGE).await?;
            let oldest = page.iter().map(|message| message.id).min();
            let complete = page.len() < usize::from(PAGE) || oldest.is_some_and(|id| id <= cursor);
            ensure!(
                before.is_none_or(|bound| page.iter().all(|message| message.id < bound)),
                "Discord history did not advance its page boundary"
            );
            for message in page.into_iter().filter(|message| message.id > cursor) {
                batch.highest = batch.highest.max(message.id);
                if message.author.id != self.owner
                    || message.author.bot
                    || message.author.system
                    || message.webhook_id.is_some()
                    || !matches!(message.kind, 0 | 19)
                {
                    continue;
                }
                let text = message.content.context(
                    "Discord owner message content unavailable: check Message Content Intent",
                )?;
                if !text.trim().is_empty() {
                    bytes += text.len();
                    ensure!(
                        bytes <= 8 * 1024 * 1024,
                        "Discord owner backlog exceeded its byte limit"
                    );
                    batch.requests.push((message.id, text));
                }
            }
            if complete {
                batch.requests.sort_unstable_by_key(|(id, _)| *id);
                batch.requests.dedup_by_key(|(id, _)| *id);
                return Ok(batch);
            }
            before = oldest;
        }
        anyhow::bail!("Discord backlog exceeds the bounded history window; no cursor was advanced")
    }
}
