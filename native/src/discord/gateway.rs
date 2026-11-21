use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};
use futures_util::{SinkExt as _, StreamExt as _};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    net::TcpStream,
    sync::mpsc,
    time::{Instant, sleep, sleep_until, timeout},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

use super::{Interaction, Snowflake, wake::Wake};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Deserialize)]
struct Frame {
    op: u8,
    s: Option<u64>,
    t: Option<String>,
    #[serde(default)]
    d: Value,
}

#[derive(Deserialize)]
struct Hello {
    heartbeat_interval: u64,
}

#[derive(Deserialize)]
struct Ready {
    session_id: String,
    resume_gateway_url: String,
}

struct Resume {
    url: Url,
    id: String,
    sequence: u64,
}

enum Outcome {
    Reconnect,
    Restart,
    Fatal(u16),
}

pub(super) struct Link<'a> {
    pub(super) url: &'a Url,
    pub(super) token: &'a str,
    pub(super) channels: &'a [Snowflake],
    pub(super) owner: Snowflake,
    pub(super) wake: &'a Wake,
    pub(super) interactions: mpsc::Sender<Interaction>,
}

impl Link<'_> {
    pub(super) async fn run(self) -> Result<()> {
        let mut resume = None;
        let mut delay = 1;
        loop {
            let started = Instant::now();
            match self.connect(&mut resume).await {
                Ok(Outcome::Fatal(code)) => {
                    bail!("Discord Gateway closed with non-retryable code {code}")
                }
                Ok(Outcome::Restart) => resume = None,
                Ok(Outcome::Reconnect) | Err(_) => {}
            }
            if started.elapsed() >= Duration::from_secs(30) {
                delay = 1;
            }
            let minimum = if resume.is_some() { 1 } else { 6 };
            sleep(Duration::from_secs(delay.max(minimum))).await;
            delay = (delay * 2).min(30);
        }
    }

    async fn connect(&self, resume: &mut Option<Resume>) -> Result<Outcome> {
        let url = resume.as_ref().map_or(self.url, |state| &state.url);
        let config = WebSocketConfig::default()
            .max_message_size(Some(1024 * 1024))
            .max_frame_size(Some(1024 * 1024));
        let (mut ws, _) = timeout(
            Duration::from_secs(10),
            connect_async_with_config(url.as_str(), Some(config), true),
        )
        .await??;
        let hello = timeout(Duration::from_secs(10), ws.next())
            .await?
            .context("Discord Gateway closed before HELLO")??;
        let Message::Text(hello) = hello else {
            bail!("expected Discord Gateway HELLO");
        };
        let hello: Frame = serde_json::from_str(hello.as_str())?;
        ensure!(hello.op == 10, "expected Discord Gateway HELLO");
        let hello: Hello = serde_json::from_value(hello.d)?;
        ensure!(
            (100..=120_000).contains(&hello.heartbeat_interval),
            "invalid Discord Gateway heartbeat interval"
        );
        let interval = Duration::from_millis(hello.heartbeat_interval);
        let first = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
            % u128::from(hello.heartbeat_interval);
        let mut heartbeat = Instant::now() + Duration::from_millis(u64::try_from(first)?);
        let mut awaiting_ack = false;
        let handshake = Instant::now() + Duration::from_secs(20);
        let mut ready = false;
        let authenticate = resume.as_ref().map_or_else(
            || json!({"op": 2, "d": {"token": self.token, "intents": (1 << 9) | (1 << 12) | (1 << 15),
                "properties": {"os": std::env::consts::OS, "browser": "cataly", "device": "cataly"}}}),
            |state| json!({"op": 6, "d": {"token": self.token, "session_id": state.id, "seq": state.sequence}}),
        );
        send(&mut ws, &authenticate).await?;
        loop {
            tokio::select! {
                () = sleep_until(handshake), if !ready => return Ok(Outcome::Reconnect),
                () = sleep_until(heartbeat) => {
                    if awaiting_ack { return Ok(Outcome::Reconnect); }
                    beat(&mut ws, resume.as_ref()).await?;
                    awaiting_ack = true;
                    heartbeat = Instant::now() + interval;
                }
                incoming = ws.next() => {
                    let Some(incoming) = incoming else { return Ok(Outcome::Reconnect); };
                    match incoming? {
                        Message::Text(text) => {
                            let frame: Frame = serde_json::from_str(text.as_str())?;
                            if let (Some(state), Some(sequence)) = (resume.as_mut(), frame.s) {
                                state.sequence = state.sequence.max(sequence);
                            }
                            match frame.op {
                                0 => self.dispatch(frame, resume, &mut ready)?,
                                1 => { beat(&mut ws, resume.as_ref()).await?; awaiting_ack = true; }
                                7 => return Ok(Outcome::Reconnect),
                                9 if frame.d == Value::Bool(true) => return Ok(Outcome::Reconnect),
                                9 => return Ok(Outcome::Restart),
                                11 => awaiting_ack = false,
                                _ => {}
                            }
                        }
                        Message::Ping(_) => timeout(Duration::from_secs(3), ws.flush()).await??,
                        Message::Close(Some(close)) => return Ok(match u16::from(close.code) {
                            code @ (4004 | 4010..=4014) => Outcome::Fatal(code),
                            1000 | 1001 | 4003 | 4005 | 4007 | 4009 => Outcome::Restart,
                            _ => Outcome::Reconnect,
                        }),
                        Message::Close(None) => return Ok(Outcome::Reconnect),
                        _ => {}
                    }
                }
            }
        }
    }

    fn dispatch(&self, frame: Frame, resume: &mut Option<Resume>, ready: &mut bool) -> Result<()> {
        match frame.t.as_deref() {
            Some("READY") => {
                let event: Ready = serde_json::from_value(frame.d)?;
                let url = if self.url.scheme() == "ws" {
                    self.url.clone()
                } else {
                    let mut url = Url::parse(&event.resume_gateway_url)
                        .context("invalid Discord resume URL")?;
                    ensure!(
                        url.scheme() == "wss"
                            && url
                                .host_str()
                                .is_some_and(|host| host.ends_with(".discord.gg")
                                    || host == "gateway.discord.gg")
                            && url.username().is_empty()
                            && url.password().is_none(),
                        "invalid Discord resume host"
                    );
                    url.set_query(Some("v=10&encoding=json"));
                    url
                };
                let sequence = frame.s.context("missing Discord sequence")?;
                *resume = Some(Resume {
                    url,
                    id: event.session_id,
                    sequence,
                });
                *ready = true;
                self.wake.send(Wake::ALL);
            }
            Some("RESUMED") if resume.is_some() => {
                *ready = true;
                self.wake.send(Wake::ALL);
            }
            Some("MESSAGE_CREATE") if *ready || resume.is_some() => {
                #[derive(Deserialize)]
                struct Notice {
                    channel_id: Snowflake,
                    author: super::User,
                }
                if let Ok(event) = serde_json::from_value::<Notice>(frame.d)
                    && event.author.id == self.owner
                    && !event.author.bot
                    && !event.author.system
                    && let Ok(index) = self.channels.binary_search(&event.channel_id)
                {
                    self.wake.send(1 << index);
                }
            }
            Some("INTERACTION_CREATE") if *ready || resume.is_some() => {
                if let Ok(event) = serde_json::from_value::<Interaction>(frame.d)
                    && event.valid()
                    && self.channels.contains(&event.channel_id)
                {
                    // Never block heartbeats on user work or a slow callback.
                    if self.interactions.try_send(event).is_err() {
                        eprintln!("DISCORD_INTERACTION_QUEUE_FULL");
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}

async fn beat(ws: &mut Socket, resume: Option<&Resume>) -> Result<()> {
    send(
        ws,
        &json!({"op": 1, "d": resume.map(|state| state.sequence)}),
    )
    .await
}

async fn send(ws: &mut Socket, value: &Value) -> Result<()> {
    timeout(
        Duration::from_secs(3),
        ws.send(Message::text(value.to_string())),
    )
    .await??;
    Ok(())
}
