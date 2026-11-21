<p align="center">
  <img src="docs/cataly-portrait.webp" width="320" alt="Cataly character portrait: silver hair and a crimson halo">
</p>

<h1 align="center">Cataly</h1>

<p align="center">
  <strong>Understand the intent. Read the context. See the work through.</strong>
</p>

<p align="center">
  Cataly is an AI teammate for software work. Give it a goal and the constraints
  that matter, not a command for every step. It can take a request from Discord,
  work in a tracked coding session, and bring back a result you can verify.
</p>

<p align="center">
  <a href="https://github.com/vntrevx/Cataly/releases/tag/v0.1.2"><img alt="Published preview" src="https://img.shields.io/github/v/release/vntrevx/Cataly?include_prereleases&label=preview&labelColor=2b2d33&color=c8102e"></a>
  <a href="https://github.com/vntrevx/Cataly/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI on main" src="https://img.shields.io/github/actions/workflow/status/vntrevx/Cataly/ci.yml?branch=main&label=ci&labelColor=2b2d33"></a>
  <a href="LICENSING.md"><img alt="License: SUL 1.0 with a scoped MIT notice" src="https://img.shields.io/badge/license-SUL%201.0%20%2B%20scoped%20MIT-8b9099?labelColor=2b2d33"></a>
  <a href="https://bun.sh"><img alt="Bun 1.4.4 or later" src="https://img.shields.io/badge/bun-%E2%89%A51.4.4-8b9099?labelColor=2b2d33&logo=bun&logoColor=white"></a>
</p>

<p align="center">
  <a href="#get-started"><strong>Get started</strong></a> ·
  <a href="#how-it-works"><strong>How it works</strong></a> ·
  <a href="#documentation"><strong>Documentation</strong></a> ·
  <a href="#contributing"><strong>Contributing</strong></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a><br>
  <a href="README.de.md">Deutsch</a> · <a href="README.it.md">Italiano</a> · <a href="README.zh.md">中文</a>
</p>

## Give it an outcome, not a script

<table width="100%"><tr><td>

**Example request**

*Investigate the flaky login test. Keep the public API unchanged, run the
relevant tests, and open a PR with the cause and the verification results.*

</td></tr></table>

<table>
  <tr>
    <td width="33%" valign="top">
      <h4>Understand the intent</h4>
      The flaky test is the symptom. The goal is a fix you can review, with the
      public API intact. Cataly uses that distinction to choose what to
      investigate and what to leave alone.
    </td>
    <td width="33%" valign="top">
      <h4>Read the context</h4>
      The conversation, repository conventions, constraints, and your stated
      preferences inform the next step. Routine decisions belong to Cataly; real
      tradeoffs and permission decisions belong to you.
    </td>
    <td width="33%" valign="top">
      <h4>See the work through</h4>
      A patch is not the finish line. Check the agreed outcome, report the
      evidence, and say what remains unverified.
    </td>
  </tr>
</table>

The difference is not another chat interface. It is the link between the request,
its working session, and the evidence that it is done.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-it-works-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/how-it-works-light.svg">
  <img src="docs/how-it-works-light.svg" width="100%" alt="Workflow: a request arrives, the lead assigns it, a lane works and reports, and completion is checked before a result you can verify, with its evidence, comes back to you.">
</picture>

Here is the workflow on current `main`:

1. **A request arrives.** With Discord intake enabled, Cataly reads messages from
   the configured owner and carries available reply context and attachment
   metadata into the work.
2. **The lead assigns the work.** The lead can handle small requests directly or
   launch a **lane**: a dedicated [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi)
   coding session with a brief and an explicit `Done` condition. Native sessions run without a terminal by default.
   The lane registry ties the work to its session and messenger thread.
3. **The lane works and reports.** Worklogs, reports, and checkpoints make
   progress inspectable across restarts. Ordinary Discord chat
   for an unambiguously linked lane reaches that lane’s native OMP session;
   an exact reply to a supported ASK form answers the form instead.
4. **Completion is checked.** A lane’s “done” claim is not proof. The Done flow
   can read back a command result, file state, merged PR, or published package
   version. A passing check proves that signal, not every possible outcome.

## You stay in control

- Cataly uses your accounts and permissions. Taking initiative does not grant
  permission for external actions.
- Installation starts no agent, messenger receiver, or service. Enable only the
  monitors and integrations you want.
- Keep credentials and private transcripts out of public reports.
- Optional telemetry is off by default. Set `CATALY_TELEMETRY=1` to opt in;
  `DO_NOT_TRACK=1` overrides it.

## Get started

<table width="100%"><tr><td>

**Note**

Use `cataly` for operation, `cataly-harness` for the standalone harness, and
`omp-cataly` for a separate installation. Fresh homes default to `~/.cataly`
(primary) or `~/.omp-cataly` (side). An upgrade stays in its original home.

[Install a verified current release](docs/releases.md#install-a-current-release)
or [upgrade an existing v0.1.3 installation without terminal tooling](docs/releases.md#upgrade-a-v013-installation).
The upgrade leaves existing configuration unchanged.

</td></tr></table>

### Install the npm package

With Bun 1.4.4 or newer available on `PATH`, run one of these in your project
directory:

```bash
npm install cataly
# Or, with Bun:
bun add cataly
```

The Cataly package exposes `cataly-harness`:

```bash
./node_modules/.bin/cataly-harness --help
```

This installs the harness CLI, not the full OMP and messenger setup. For that
setup, use one of the options below.

|                | [Published preview](#try-the-published-preview) | [Current source](#work-from-current-source)          |
| -------------- | ----------------------------------------------- | ---------------------------------------------------- |
| **Build**      | v0.1.2 prerelease                               | current `main`                                       |
| **Scope**      | Linux x64 / herdr / Discord                     | native headless sessions; optional herdr or hc       |
| **OMP**        | independently installed native OMP 18.18.8      | pinned, patched OMP 18.20.0 with the omp-ulw overlay |
| **Home**       | historical primary `~/.dori`                   | side mode `~/.omp-cataly`                            |

### Try the published preview

The [v0.1.2 prerelease](https://github.com/vntrevx/Cataly/releases/tag/v0.1.2)
is the published **Linux x64 / herdr / Discord** preview. The tested baseline
is Ubuntu 24.04 x64, Bun 1.4.4, native OMP 18.18.8, and herdr 0.9.5. This tag
requires an independently installed OMP and uses the historical `~/.dori` home.
It does not contain the newer `main` features or toolchain.

1. [Install the exact preview](https://github.com/vntrevx/Cataly/blob/v0.1.2/docs/releases.md#install-the-exact-preview).
   Check its [prerequisites](https://github.com/vntrevx/Cataly/blob/v0.1.2/docs/releases.md#prerequisites-and-trust)
   and verify the matching release assets before running their installer.
2. [Configure your provider and Discord bot, then start Dori](https://github.com/vntrevx/Cataly/blob/v0.1.2/docs/releases.md#your-authentication-and-explicit-startup).
   Use your own provider account and allowance, bot token, owner ID, and channel ID.
3. [Enable Discord intake](https://github.com/vntrevx/Cataly/blob/v0.1.2/docs/releases.md#discord-owner-intake).
   Wait for `INBOUND_READY`, then send a fresh message in the configured channel.
   Old messages are not replayed on first start.

### Work from current source

Use a separate checkout with git and Bun 1.4.4+. On Linux and macOS the
default session runtime needs neither herdr nor hc. The installer prepares the pinned, patched **OMP 18.20.0**
and **omp-ulw** overlay; a stock `omp` is not a substitute. No preinstalled OMP
or Cargo is needed for this default setup.

To inspect configuration changes first, add `--preview` to the final command below;
review its paths and hashes, then run it without that flag to install. The preview
does not update the checkout, prepare dependencies, or change installation files.

```bash
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/Cataly" || exit 1
cd "$HOME/src/Cataly" || exit 1
CATALY_INSTALL_MODE=side CATALY_NO_PULL=1 CATALY_SRC="$PWD" \
  bash scripts/install-source.sh
```

Side mode uses `~/.omp-cataly` by default and leaves the primary `~/.cataly`
installation alone. Use `omp-cataly omp` to open the bound OMP for provider
setup, and `omp-cataly harness up` to start the harness explicitly. Follow the
[source setup and startup guide](docs/releases.md#source-checkouts-for-maintainers)
for your runtime and messenger. Use `omp-cataly doctor` for a read-only setup
check and `omp-cataly status` to see your lanes.

For new sessions, `cataly harness status` shows `RUNTIME headless (from default)`
unless you explicitly select another runtime. Old installations may have
`"runtime": "hc"` or `"herdr"`; leave that field in place. To opt in to a terminal
for new sessions, set `"sessionRuntime": "hc"` or `"herdr"`. Stored terminal
sessions still belong to their original backend.

Opt-in [source updates](skills/cataly-mode/references/scripts.md#ci-gated-source-updates)
follow CI-passing main with idle and quiet admission, same-session restart,
monitor health, and rollback. This is separate from consumer release updates
and the model-assisted `cataly upstream` workflow.

### Develop the Rust controller for stock OMP

This opt-in CLI does not change the default source installation above. Build
it with Cargo, then run it by path so it does not replace an installed
`cataly` command:

```bash
cargo build --locked --release
./target/release/cataly --omp "$(command -v omp)" doctor
./target/release/cataly --omp "$(command -v omp)" harness --state-dir ./.cataly-native <<'JSON'
{"op":"run","id":"request-1","key":"review","prompt":"Explain the task in one paragraph."}
{"op":"receipt","id":"request-1"}
JSON
```

`doctor` probes RPC without submitting a prompt. `resume` verifies an exact
OMP session file and ID. On Unix, `harness` starts a lane on demand and can
resume it from a separate state directory on the next request. `open`, `status`,
and `close` also manage resident sessions explicitly. Repeating a request ID
with the same input retrieves the stored receipt without another model call;
uncertain requests are held, not replayed. `run` uses the configured OMP model
and currently returns text only. It does not handle tools, approvals, or
messenger delivery.

For interactive clients, `run_controlled` accepts the same fields as `run`.
While it is active, send `{"op":"run_status","id":"request-1"}` or
`{"op":"cancel","id":"request-1"}` on the same stream. Control replies carry
`control: "running"` or `"cancelling"`; the run's receipt arrives separately.
Cancellation before dispatch leaves no run claim. After dispatch, Cataly closes
the lane's OMP process. An unconfirmed outcome is not a rollback and must not
be automatically replayed.

`run_with_tools` takes the same fields and opens a new or parked lane with
one read-only tool, `cataly_read_readme`. When OMP calls it, Cataly emits
`{"id":"request-1","approval_id":"…","tool":"cataly_read_readme"}`.
On the same stream, reply with
`{"op":"decide","id":"request-1","approval_id":"…","decision":"approve"}` or
use `"deny"`. Only an exact, pending approval ID is accepted. The decision
acknowledgement is separate from the final run receipt. Approval reads only
the lane's `README.md`: a regular UTF-8 file up to 16 KiB with no symbolic or
hard links. Denial or disconnect before approval discloses no file content.
`run` and `run_controlled` still use the text-only path.

Build with `cargo build --release`. On Unix, the Rust binary can run Discord
without Bun: `target/release/cataly --cwd "$WORKSPACE" discord --state-dir "$STATE_DIR" --channel "$CHANNEL_ID" --gateway`.
Set `CATALY_DISCORD_TOKEN` and `CATALY_DISCORD_OWNER_ID` in its environment.
Without `--gateway`, Rust uses REST polling; `--poll-seconds 0` runs one poll.
The existing `cataly inbound discord` can launch the Rust monitor with:

| Setting | Value |
| --- | --- |
| `CATALY_DISCORD_NATIVE_BIN` | Absolute path to the Rust binary (`target/release/cataly`). |
| `CATALY_DISCORD_NATIVE_WORKSPACE` | Absolute path to the workspace whose `README.md` may be approved. |
| `CATALY_DISCORD_NATIVE_CHANNEL_ID` | Optional exact channel or thread ID from the inbound list. If unset, use all explicitly listed inbound channels, not auto-discovered channels. |
| `CATALY_OMP` / `CATALY_DISCORD_NATIVE_MODEL` | Optional OMP executable and model overrides. |

Rust owns Gateway heartbeat and resume, REST history and sends, button
callbacks, and the OMP lane. It only watches explicitly listed channels or
threads. Stop the legacy monitor before switching; the compatibility launcher
imports the existing channel cursor on first use. Legacy head/ASK routing and
the `--context`, `--wake-lanes`, and `--activity-file` flags stay with the legacy
command configuration, without `CATALY_DISCORD_NATIVE_BIN`.

Ordinary owner text runs with OMP's tools disabled; attachments are not
downloaded. Follow-ups reuse the saved session, and the OMP process exits
between turns. On Gateway, `!cataly <request>` enables the approval-gated
README tool when OMP advertises host tools. Use private channels: results are
visible to channel members and reply to the original message.

Rust records a send intent before each Discord reply part and saves the remote
message ID after confirmation. Restarting does not rerun completed requests or
repeat confirmed parts. If a POST cannot be confirmed, that part and later
parts are held rather than retried blindly. Check the monitor for
`DISCORD_REPLY_HELD` and inspect the original thread and the native state
directory before reconciling a receipt.

#### Local memory for native Discord

The native monitor uses the local [ai-memory](https://github.com/akitaonrails/ai-memory)
installation when `~/.local/bin/ai-memory` exists. Use `CATALY_MEMORY_BIN`
to select another absolute binary path, or set it to an empty value to turn
off native checkpoints. The recorder is a separate bounded local worker,
not another model call. It indexes notes on `127.0.0.1:49374`; if the server
is down, private checkpoints remain on disk for later export.

Cataly checkpoints bounded owner text to its room. It exports after eight
new notes, on the ten-minute maintenance tick, or when the session reaches
16 MB, before the 20 MB warning point. For durable notes use
`!remember room …`, `!remember person …`, `!remember project …`, or
`!remember common …`. These commands save locally without launching OMP.
Only explicit notes leave the room scope, and common notes are shared across
projects within the same bot-owner account and state directory, never
between owners. Person notes are not sent into channel replies. Read them
locally in ai-memory. Approved tool output and attachments are not captured.
Checkpoints do not delete, truncate, or rotate the original OMP session.

Cataly depends on the installed OMP's public RPC, not its version string,
SDK, or patched core. The latest official Linux release is tested daily by
the `Cataly Native` workflow alongside pinned release tests on changes.
Use `cataly doctor` to check the installed protocol and optional host tools.
An incompatible RPC change still needs an adapter fix; an ambiguous turn stays
held rather than being replayed. Build with `--no-default-features` if you
only want the OMP harness without Discord's networking libraries.

<table width="100%"><tr><td>

**Important**

**Support boundary:** Slack and Telegram are retained source integrations, not
part of the published preview. The installer can support isolated macOS arm64 / hc
consumer profiles declared by a compatible release manifest; no such release is
claimed here. A merge to `main` does not update the published preview.

</td></tr></table>

## Documentation

| Set up and operate                                                          | Go deeper                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Installation, support, updates, and rollback](docs/releases.md)            | [Runtime adapters and session contracts](docs/runtime.md)                       |
| [Messenger setup](skills/cataly-mode/references/setup.md)                     | [Container setup for source development](docs/container.md)                     |
| [Cataly operating rules](skills/cataly-mode/SKILL.md)                           | [Scheduling and backlog](docs/hourly-loop.md)                                   |
| [Lane commands and configuration](skills/cataly-mode/references/scripts.md)   | [Shared locks and lane priority](docs/locks.md)                                 |
| [Done protocol](skills/cataly-mode/references/done-protocol.md)               | [Opt-in paid Discord voice assistant (current source)](docs/discord-voice.md)   |
| [Changelog](CHANGELOG.md)                                                   | [Opt-in owner profile for the lead](docs/owner-profile.md)                      |

## Contributing

Start with the [contribution guide](CONTRIBUTING.md), check the
[issues](https://github.com/vntrevx/Cataly/issues) and
[pull requests](https://github.com/vntrevx/Cataly/pulls), and bring a focused
change with evidence that it works.

## Licenses and attribution

Cataly integrates [dori-superagent](https://github.com/sisyphuslabs/dori-superagent),
[oh-my-pi](https://github.com/can1357/oh-my-pi), and
[omp-ulw](https://github.com/dbc-hbin/omp-ulw). The dori-superagent-derived
material retains the [Sustainable Use License 1.0](LICENSE). The existing OMP
integration retains its [MIT license and copyright notices](LICENSE.integration);
the MIT notice does not apply to the whole repository. Other components keep
their own terms. See the [licensing guide](LICENSING.md) and [NOTICE](NOTICE) for
source revisions and modified-copy attribution.
