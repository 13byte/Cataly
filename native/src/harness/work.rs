use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{Harness, SessionKey, store::Claim};
use crate::rpc::TurnOutcome;

#[derive(Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(try_from = "String")]
pub struct RunId(String);

impl RunId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for RunId {
    type Error = &'static str;

    fn try_from(value: String) -> std::result::Result<Self, Self::Error> {
        if (1..=96).contains(&value.len())
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            Ok(Self(value))
        } else {
            Err("request ID must be 1–96 ASCII letters, digits, hyphens or underscores")
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Run {
    id: RunId,
    key: SessionKey,
    prompt: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct RunClaim {
    pub id: RunId,
    pub lane: String,
    pub session_id: String,
    fingerprint: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Outcome {
    Completed { text: String },
    Failed { reason: String },
    Unconfirmed { reason: String },
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RunReceipt {
    pub claim: RunClaim,
    #[serde(flatten)]
    outcome: Outcome,
}

impl RunReceipt {
    pub const fn is_terminal(&self) -> bool {
        matches!(
            self.outcome,
            Outcome::Completed { .. } | Outcome::Failed { .. }
        )
    }

    const fn held(claim: RunClaim, reason: String) -> Self {
        Self {
            claim,
            outcome: Outcome::Unconfirmed { reason },
        }
    }
}

impl Harness<'_, '_> {
    pub(super) fn lookup_run(&self, id: &RunId) -> Result<RunReceipt> {
        match self.store.receipt(id)? {
            Claim::Missing => bail!("unknown Cataly request: {}", id.as_str()),
            Claim::Pending(claim) => Ok(RunReceipt::held(
                claim,
                "request outcome is unconfirmed; it will not be replayed".to_owned(),
            )),
            Claim::Done(receipt) => Ok(receipt),
        }
    }

    pub(super) async fn execute(&mut self, run: Run) -> Result<RunReceipt> {
        let Run { id, key, prompt } = run;
        ensure!(
            key.0 != "head",
            "Cataly run requires a lane key, not the head"
        );
        ensure!(
            !prompt.trim().is_empty() && !prompt.trim_start().starts_with('/'),
            "Cataly run requires nonempty text, not an OMP slash command"
        );
        let fingerprint = format!("{:x}", Sha256::digest(prompt.as_bytes()));
        match self.store.receipt(&id)? {
            Claim::Missing => {}
            Claim::Pending(claim) => {
                ensure!(
                    claim.lane == key.0 && claim.fingerprint == fingerprint,
                    "request ID was already used for different input"
                );
                return Ok(RunReceipt::held(
                    claim,
                    "request outcome is unconfirmed; it will not be replayed".to_owned(),
                ));
            }
            Claim::Done(receipt) => {
                ensure!(
                    receipt.claim.lane == key.0 && receipt.claim.fingerprint == fingerprint,
                    "request ID was already used for different input"
                );
                return Ok(receipt);
            }
        }
        self.store.lane_available(&key.0)?;
        let temporary = !self.sessions.contains_key(&key);
        if temporary {
            self.open(SessionKey(key.0.clone()), None, false).await?;
        }
        let result = self.dispatch(id, &key, fingerprint, &prompt).await;
        let shutdown = if temporary {
            let live = self
                .sessions
                .remove(&key)
                .context("Cataly lane is not open")?;
            live.rpc.close().await
        } else {
            Ok(())
        };
        match (result, shutdown) {
            (Ok(receipt), Ok(())) => {
                if receipt.is_terminal() {
                    self.store.finish_run(&receipt)?;
                }
                Ok(receipt)
            }
            (Ok(receipt), Err(error)) => Ok(RunReceipt::held(
                receipt.claim,
                format!("could not confirm OMP lane shutdown: {error:#}"),
            )),
            (Err(error), Ok(())) => Err(error),
            (Err(error), Err(shutdown)) => {
                Err(error).context(format!("OMP lane shutdown also failed: {shutdown:#}"))
            }
        }
    }

    async fn dispatch(
        &mut self,
        id: RunId,
        key: &SessionKey,
        fingerprint: String,
        prompt: &str,
    ) -> Result<RunReceipt> {
        let live = self
            .sessions
            .get_mut(key)
            .context("Cataly lane is not open")?;
        live.verify().await?;
        let claim = RunClaim {
            id,
            lane: key.0.clone(),
            session_id: live.binding.session.id.clone(),
            fingerprint,
        };
        self.store.claim(&claim)?;
        let turn = match live.rpc.run_turn(prompt).await {
            Ok(turn) => turn,
            Err(error) => {
                live.faulted = true;
                return Ok(RunReceipt::held(claim, format!("{error:#}")));
            }
        };
        if let Err(error) = live.verify().await {
            return Ok(RunReceipt::held(claim, format!("{error:#}")));
        }
        let outcome = match turn {
            TurnOutcome::Completed(text) => Outcome::Completed { text },
            TurnOutcome::Failed(reason) => Outcome::Failed {
                reason: reason.to_owned(),
            },
        };
        Ok(RunReceipt { claim, outcome })
    }
}
