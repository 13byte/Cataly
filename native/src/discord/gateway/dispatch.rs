use anyhow::{Context, Result, ensure};
use reqwest::Url;
use serde::Deserialize;

use super::{Frame, Link, Resume};
use crate::discord::{Interaction, Snowflake, User, wake::Wake};

#[derive(Deserialize)]
struct Ready {
    session_id: String,
    resume_gateway_url: String,
}

impl Link<'_> {
    pub(super) fn dispatch(
        &self,
        frame: Frame,
        resume: &mut Option<Resume>,
        ready: &mut bool,
    ) -> Result<Option<&'static str>> {
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
                if let Some(intake) = &self.intake {
                    intake.wake.send(Wake::ALL);
                }
                return Ok(Some("READY"));
            }
            Some("RESUMED") if resume.is_some() => {
                *ready = true;
                if let Some(intake) = &self.intake {
                    intake.wake.send(Wake::ALL);
                }
                return Ok(Some("RESUMED"));
            }
            Some("MESSAGE_CREATE") if *ready || resume.is_some() => {
                #[derive(Deserialize)]
                struct Notice {
                    channel_id: Snowflake,
                    author: User,
                }
                if let Some(intake) = &self.intake
                    && let Ok(event) = serde_json::from_value::<Notice>(frame.d)
                    && event.author.id == intake.owner
                    && !event.author.bot
                    && !event.author.system
                    && let Ok(index) = intake.channels.binary_search(&event.channel_id)
                {
                    intake.wake.send(1 << index);
                }
            }
            Some("INTERACTION_CREATE") if *ready || resume.is_some() => {
                if let Some(intake) = &self.intake
                    && let Ok(event) = serde_json::from_value::<Interaction>(frame.d)
                    && event.valid()
                    && intake.channels.contains(&event.channel_id)
                {
                    // Never block heartbeats on user work or a slow callback.
                    if intake.interactions.try_send(event).is_err() {
                        eprintln!("DISCORD_INTERACTION_QUEUE_FULL");
                    }
                }
            }
            _ => {}
        }
        Ok(None)
    }
}
