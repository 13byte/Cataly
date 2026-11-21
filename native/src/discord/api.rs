use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use base64::Engine as _;
use reqwest::{Client, Method, StatusCode, Url, header};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use super::{BotProfile, Message, Snowflake};

pub(super) struct DiscordApi {
    client: Client,
    base: Url,
    authorization: header::HeaderValue,
}

#[derive(Deserialize)]
struct Receipt {
    id: Snowflake,
    channel_id: Snowflake,
    message_reference: Option<Reference>,
}

#[derive(Deserialize)]
struct Reference {
    message_id: Snowflake,
    channel_id: Snowflake,
}

impl DiscordApi {
    pub(super) fn new(base: Url, token: &str) -> Result<Self> {
        let mut authorization = header::HeaderValue::from_str(&format!("Bot {token}"))
            .context("invalid Discord bot token")?;
        authorization.set_sensitive(true);
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(8))
            .build()?;
        Ok(Self {
            client,
            base,
            authorization,
        })
    }

    pub(super) async fn identity(&self) -> Result<BotProfile> {
        self.get("users/@me").await
    }

    pub(super) async fn require_message_content(&self) -> Result<()> {
        #[derive(Deserialize)]
        struct Application {
            flags: u64,
        }
        let app: Application = self.get("applications/@me").await?;
        ensure!(
            (app.flags & ((1 << 18) | (1 << 19))) != 0,
            "Enable Discord Message Content Intent before starting native intake"
        );
        Ok(())
    }

    pub(super) async fn set_default_avatar(&self, path: &Path) -> Result<()> {
        use tokio::io::AsyncReadExt as _;
        let file = tokio::fs::File::open(path).await?;
        let mut bytes = Vec::new();
        file.take(512 * 1024 + 1).read_to_end(&mut bytes).await?;
        ensure!(
            bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.len() <= 512 * 1024,
            "invalid default Discord JPEG"
        );
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        self.call(
            Method::PATCH,
            "users/@me",
            Some(&json!({ "avatar": format!("data:image/jpeg;base64,{encoded}") })),
            true,
        )
        .await?;
        Ok(())
    }

    pub(super) async fn history(
        &self,
        channel: Snowflake,
        before: Option<Snowflake>,
        limit: u8,
    ) -> Result<Vec<Message>> {
        let mut path = format!("channels/{channel}/messages?limit={limit}");
        if let Some(before) = before {
            use std::fmt::Write as _;
            write!(path, "&before={before}")?;
        }
        let page: Vec<Message> = self.get(&path).await?;
        ensure!(
            page.len() <= usize::from(limit)
                && page.iter().all(|message| message.channel_id == channel),
            "Discord history response did not match its channel or page limit"
        );
        Ok(page)
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        serde_json::from_slice(&self.call(Method::GET, path, None, true).await?)
            .context("invalid Discord REST response")
    }

    pub(super) async fn reply(
        &self,
        origin: Destination,
        content: &str,
        extras: ReplyExtras<'_>,
    ) -> Result<Snowflake> {
        let mut body = json!({
            "content": content,
            "allowed_mentions": { "parse": [], "replied_user": false },
            "message_reference": { "message_id": origin.message, "channel_id": origin.channel, "fail_if_not_exists": true }
        });
        match extras {
            ReplyExtras::Part { nonce } => {
                body["nonce"] = json!(nonce);
                body["enforce_nonce"] = json!(true);
            }
            ReplyExtras::Approval { stamp } => {
                body["components"] = json!([{
                    "type": 1,
                    "components": [
                        {"type": 2, "style": 3, "label": "Approve", "custom_id": format!("cataly-readme:{stamp}:approve")},
                        {"type": 2, "style": 4, "label": "Deny", "custom_id": format!("cataly-readme:{stamp}:deny")}
                    ]
                }]);
            }
        }
        let path = format!("channels/{}/messages", origin.channel);
        let receipt: Receipt =
            serde_json::from_slice(&self.call(Method::POST, &path, Some(&body), true).await?)
                .context("Discord did not confirm the reply message")?;
        ensure!(
            receipt.channel_id == origin.channel
                && receipt
                    .message_reference
                    .is_some_and(|reference| reference.message_id == origin.message
                        && reference.channel_id == origin.channel),
            "Discord reply destination did not match its source"
        );
        Ok(receipt.id)
    }

    pub(super) async fn clear(&self, channel: Snowflake, message: Snowflake) -> Result<()> {
        self.call(
            Method::PATCH,
            &format!("channels/{channel}/messages/{message}"),
            Some(&json!({"components": []})),
            true,
        )
        .await?;
        Ok(())
    }

    pub(super) async fn callback(&self, event: &super::Interaction, accepted: bool) -> Result<()> {
        let path = format!("interactions/{}/{}/callback", event.id, event.token);
        let body = if accepted {
            json!({"type": 7, "data": {"components": []}})
        } else {
            json!({"type": 4, "data": {"content": "This approval is inactive or not yours.", "flags": 64}})
        };
        // The callback uses its own token, not the bot authorization header.
        tokio::time::timeout(
            Duration::from_millis(2_500),
            self.call(Method::POST, &path, Some(&body), false),
        )
        .await??;
        Ok(())
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        auth: bool,
    ) -> Result<Vec<u8>> {
        let url = self.base.join(path)?;
        for trial in 0..2 {
            let mut request = self.client.request(method.clone(), url.clone());
            if auth {
                request = request.header(header::AUTHORIZATION, self.authorization.clone());
            }
            if let Some(body) = body {
                request = request.json(body);
            }
            let mut response = request
                .send()
                .await
                .map_err(reqwest::Error::without_url)
                .context("Discord REST I/O failed")?;
            let status = response.status();
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(reqwest::Error::without_url)?
            {
                ensure!(
                    bytes.len() + chunk.len() <= 2 * 1024 * 1024,
                    "Discord REST response exceeded its limit"
                );
                bytes.extend_from_slice(&chunk);
            }
            if status.is_success() {
                return Ok(bytes);
            }
            if status == StatusCode::TOO_MANY_REQUESTS && trial == 0 && auth {
                #[derive(Deserialize)]
                struct RateLimit {
                    retry_after: f64,
                }
                if let Ok(rate) = serde_json::from_slice::<RateLimit>(&bytes)
                    && (0.0..=5.0).contains(&rate.retry_after)
                {
                    tokio::time::sleep(Duration::from_secs_f64(rate.retry_after)).await;
                    continue;
                }
            }
            bail!("Discord REST returned HTTP {}", status.as_u16());
        }
        bail!("Discord REST request did not complete")
    }
}

#[derive(Clone, Copy, Serialize)]
pub struct Destination {
    pub(crate) channel: Snowflake,
    pub(crate) message: Snowflake,
}

pub enum ReplyExtras<'a> {
    Part { nonce: &'a str },
    Approval { stamp: &'a str },
}
