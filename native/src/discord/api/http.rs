use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use reqwest::{Method, StatusCode, header};
use serde::Deserialize;
use serde_json::Value;

use super::DiscordApi;

/// A multipart upload may need longer than the client's 8 s request timeout.
const UPLOAD_DEADLINE: Duration = Duration::from_secs(120);

/// What a request carries: a JSON value, or a finished multipart form under its boundary.
#[derive(Clone, Copy)]
pub(super) enum Payload<'a> {
    Json(&'a Value),
    Multipart { boundary: &'a str, body: &'a [u8] },
}

impl DiscordApi {
    pub(super) async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        auth: bool,
    ) -> Result<Vec<u8>> {
        self.request(method, path, body.map(Payload::Json), auth)
            .await
    }

    /// One request, sent again at most once after a 429 that asks for five seconds or less.
    pub(super) async fn request(
        &self,
        method: Method,
        path: &str,
        payload: Option<Payload<'_>>,
        auth: bool,
    ) -> Result<Vec<u8>> {
        let url = self.base.join(path)?;
        for trial in 0..2 {
            let mut request = self.client.request(method.clone(), url.clone());
            if auth {
                request = request.header(header::AUTHORIZATION, self.authorization.clone());
            }
            request = match payload {
                Some(Payload::Json(body)) => request.json(body),
                Some(Payload::Multipart { boundary, body }) => request
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .timeout(UPLOAD_DEADLINE)
                    .body(body.to_vec()),
                None => request,
            };
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
            return Err(super::RestStatus {
                status: status.as_u16(),
                code: None,
            }
            .into());
        }
        bail!("Discord REST request did not complete")
    }
}
