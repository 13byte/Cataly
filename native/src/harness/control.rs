use std::path::PathBuf;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use super::work::{Run, RunId, RunReceipt};
use super::{Harness, SessionKey, Status};

const MAX_REQUEST_BYTES: u64 = 16 * 1024;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Open {
        key: SessionKey,
        cwd: Option<PathBuf>,
    },
    Status {
        key: SessionKey,
    },
    Close {
        key: SessionKey,
    },
    Run(Run),
    Receipt {
        id: RunId,
    },
    Quit,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Reply {
    State(Status),
    Run(RunReceipt),
    Error { error: String },
}

pub(super) async fn serve(harness: &mut Harness<'_, '_>) -> Result<()> {
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    let mut line = Vec::new();
    loop {
        line.clear();
        let bytes = (&mut input)
            .take(MAX_REQUEST_BYTES + 1)
            .read_until(b'\n', &mut line)
            .await?;
        if bytes == 0 {
            return Ok(());
        }
        ensure!(
            u64::try_from(bytes)? <= MAX_REQUEST_BYTES && line.ends_with(b"\n"),
            "Cataly expected a newline-terminated JSON request no larger than 16 KiB"
        );
        let result = match serde_json::from_slice(&line) {
            Ok(Request::Open { key, cwd }) => harness.open(key, cwd, true).await.map(Reply::State),
            Ok(Request::Status { key }) => harness.status(key).await.map(Reply::State),
            Ok(Request::Close { key }) => harness.close(key).await.map(Reply::State),
            Ok(Request::Run(run)) => harness.execute(run).await.map(Reply::Run),
            Ok(Request::Receipt { id }) => harness.lookup_run(&id).map(Reply::Run),
            Ok(Request::Quit) => return Ok(()),
            Err(error) => Err(error).context("invalid Cataly request"),
        };
        let reply = match result {
            Ok(reply) => reply,
            Err(error) => Reply::Error {
                error: format!("{error:#}"),
            },
        };
        let mut data = serde_json::to_vec(&reply)?;
        data.push(b'\n');
        output.write_all(&data).await?;
        output.flush().await?;
    }
}
