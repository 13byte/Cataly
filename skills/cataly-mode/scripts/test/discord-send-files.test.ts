import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sentReceipts } from "../src/owes.ts";
import { ids } from "./discord-fakes.ts";
import { sha256, withFilesCli } from "./discord-files-fixture.ts";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const notes = "# result\n";
const thread = ["send", "discord", "--thread", ids.thread];
const reply = [...thread, "--reply", ids.message];
// POSIX-only: the stand-in native sender is a shebang script.
const posix = test.skipIf(process.platform === "win32");
const noNative =
  "send discord --file requires the native Cataly binary; nothing was sent. Build it with `cargo build --locked --release` and set CATALY_DISCORD_NATIVE_BIN to the absolute path of target/release/cataly, or reinstall Cataly on a host with a Rust toolchain so it installs $CATALY_HOME/bin/cataly-native.";
const unconfirmed = "discord send: incomplete delivery receipt; outcome uncertain";

/**
 * A stand-in for `cataly discord-send`: it records its argv, standard input and token source, then answers as
 * `CATALY_TEST_NATIVE_MODE` says: an exit status, `kill`, or a receipt built from its `--file` arguments.
 */
const standIn = (dir: string): Record<string, string> => {
  const binary = join(dir, "stand-in-native");
  writeFileSync(
    binary,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const argv = process.argv.slice(2);
const mode = process.env.CATALY_TEST_NATIVE_MODE ?? "";
const tokened = process.env.CATALY_DISCORD_TOKEN === "synthetic-ops-token";
appendFileSync(process.env.CATALY_TEST_NATIVE_LOG, JSON.stringify({ argv, text: await Bun.stdin.text(), tokened }) + "\\n");
if (mode === "kill") process.kill(process.pid, "SIGKILL");
if (/^[0-9]+$/.test(mode)) process.exit(Number(mode));
const values = (flag) => argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1]] : []));
const attachments = values("--file").map((entry, index) => {
  const [sha256, size, ...path] = entry.split(":");
  return { id: String(900 + index), filename: basename(path.join(":")), size: Number(size), sha256 };
});
const receipt = { channel: values("--thread")[0], ids: ["71"], replyConfirmed: values("--reply").length > 0, attachments };
if (mode === "hash") attachments[0].sha256 = "0".repeat(64);
if (mode === "size") attachments[0].size += 1;
if (mode === "none") receipt.attachments = [];
if (mode === "ids") receipt.ids.push("72");
if (mode === "channel") receipt.channel = "99";
console.log(JSON.stringify(receipt));
`,
    { mode: 0o700 },
  );
  return { CATALY_DISCORD_NATIVE_BIN: binary, CATALY_TEST_NATIVE_LOG: join(dir, "native.jsonl") };
};

posix(
  "the gate's size and hash go to the native sender, and its receipt is printed per attachment",
  async () => {
    await withFilesCli(async (f) => {
      const environment = standIn(f.stateDir);
      const chart = f.file("chart.png", png);
      const report = f.file("notes/report (v1).md", notes);
      const r = await f.invoke([...reply, "--text", "two files", "--file", chart, "--file", report], { environment });
      expect([r.code, r.err, r.keys]).toEqual([0, "", []]);
      expect(r.out.split("\n")).toEqual([
        "SENT 71",
        `SENT_ATTACHMENT discord ${ids.thread} 71 {"id":"900","filename":"chart.png","size":${png.length},"sha256":"${sha256(png)}"}`,
        `SENT_ATTACHMENT discord ${ids.thread} 71 {"id":"901","filename":"report (v1).md","size":${notes.length},"sha256":"${sha256(notes)}"}`,
      ]);
      // The bot token reaches the sender through its environment only, never through an argument.
      const admitted = [`${sha256(png)}:${png.length}:${chart}`, `${sha256(notes)}:${notes.length}:${report}`];
      expect(JSON.parse(readFileSync(environment["CATALY_TEST_NATIVE_LOG"]!, "utf8"))).toEqual({
        argv: [
          "discord-send",
          "--thread",
          ids.thread,
          "--reply",
          ids.message,
          "--file",
          admitted[0],
          "--file",
          admitted[1],
        ],
        text: "two files",
        tokened: true,
      });
      expect(sentReceipts(f.stateDir)).toEqual([
        expect.objectContaining({ channel: ids.thread, requestId: `${ids.thread}:${ids.message}`, remoteIds: ["71"] }),
      ]);
      // Files alone send empty text, and rendered tables stay the text of the same single message.
      const bare = await f.invoke([...thread, "--file", chart], { environment });
      const table = "| a | b |\n| - | - |\n| 1 | 2 |";
      const tabled = await f.invoke([...thread, "--render-tables", "--text", table, "--file", chart], { environment });
      expect([bare.code, tabled.code]).toEqual([0, 0]);
      const sends = readFileSync(environment["CATALY_TEST_NATIVE_LOG"]!, "utf8").trim().split("\n");
      expect(JSON.parse(sends[1]!).text).toBe("");
      expect(JSON.parse(sends[2]!).text).toStartWith("```");
    });
  },
  60_000,
);

posix(
  "a native receipt that does not show every admitted file is uncertain and settles nothing",
  async () => {
    await withFilesCli(async (f) => {
      const environment = standIn(f.stateDir);
      const args = [...reply, "--file", f.file("chart.png", png)];
      for (const [mode, err] of [
        ["hash", `${unconfirmed} (already posted: 71)`],
        ["size", `${unconfirmed} (already posted: 71)`],
        ["none", `${unconfirmed} (already posted: 71)`],
        ["ids", `${unconfirmed} (already posted: 71 72)`],
        ["channel", unconfirmed],
      ] as const) {
        const r = await f.invoke(args, { environment: { ...environment, CATALY_TEST_NATIVE_MODE: mode } });
        expect({ mode, code: r.code, out: r.out, err: r.err }).toEqual({ mode, code: 1, out: "", err });
      }
      expect(sentReceipts(f.stateDir)).toEqual([]);
    });
  },
  60_000,
);

posix(
  "the native exit status separates a refusal from an unconfirmed delivery",
  async () => {
    await withFilesCli(async (f) => {
      const environment = standIn(f.stateDir);
      const args = [...reply, "--file", f.file("chart.png", png)];
      const refused = (status: number) =>
        `discord send --file: the native sender refused the request (status ${status}); nothing was posted`;
      const uncertain =
        "discord send --file: delivery uncertain; the request may have succeeded; do not resend. Inspect the original remote target and reconcile its IDs before retrying.";
      for (const [mode, err] of [
        ["1", refused(1)],
        ["2", refused(2)],
        ["3", uncertain],
        ["70", uncertain],
        ["kill", uncertain],
      ] as const) {
        const r = await f.invoke(args, { environment: { ...environment, CATALY_TEST_NATIVE_MODE: mode } });
        expect({ mode, code: r.code, out: r.out, err: r.err }).toEqual({ mode, code: 1, out: "", err });
      }
      expect(sentReceipts(f.stateDir)).toEqual([]);
    });
  },
  60_000,
);

test("without the native binary a file send is refused before any request", async () => {
  await withFilesCli(async (f) => {
    const args = [...reply, "--text", "report", "--file", f.file("chart.png", png)];
    for (const environment of [{}, { CATALY_DISCORD_NATIVE_BIN: "off" }, { CATALY_DISCORD_NATIVE_BIN: "" }]) {
      const r = await f.invoke(args, { environment });
      expect([r.code, r.out, r.err, r.keys]).toEqual([1, "", noNative, []]);
    }
    // The same text without its file still goes through the TypeScript sender; only the file send needs the binary.
    const text = await f.invoke([...reply, "--text", "report"]);
    expect([text.code, text.out, text.keys]).toEqual([0, "SENT 71", [`POST /channels/${ids.thread}/messages`]]);
  });
}, 60_000);

test("flags that cannot carry a file are refused before any request", async () => {
  await withFilesCli(async (f) => {
    const chart = f.file("chart.png", png);
    const cases: [string[], string][] = [
      [[...thread, "--text", "x", "--file"], "--file needs a path"],
      [[...thread, "--file", ""], "--file needs a path"],
      [[...thread, "--file", chart, "--file"], "--file needs a path"],
      [
        [...thread, "--file", chart, "--edit", ids.message],
        "--file makes a new message; it cannot be used with --edit",
      ],
      [[...thread, "--file", chart, "--reply", "last"], "--reply must be a positive decimal Discord ID"],
      [["send", "discord", "--thread", "general", "--file", chart], "--thread must be a positive decimal Discord ID"],
      [[...thread, "--file", chart, "--text", ""], "--text is required"],
      [
        [...thread, "--file", chart, "--text", "t".repeat(2001)],
        "--file text exceeds 2000 UTF-16 code units; shorten the text or send it without --file",
      ],
      [["send", "discord", "--file", chart], "--to is required"],
      [["send", "telegram", "--to", "-1001", "--text", "x", "--file", chart], "--file requires cataly send discord"],
      [["send", "slack", "--to", "C1", "--text", "x", "--file", chart], "--file requires cataly send discord"],
      [
        ["thread", "discord", "create", "--to", ids.text, "--title", "t", "--file", chart],
        "--file requires cataly send discord",
      ],
    ];
    for (const [args, err] of cases) {
      const r = await f.invoke(args);
      expect({ args, code: r.code, out: r.out, err: r.err, keys: r.keys }).toEqual({
        args,
        code: 1,
        out: "",
        err,
        keys: [],
      });
    }
    const guarded = await f.invoke([...thread, "--file", chart, "--text", "run $(id) later"]);
    expect([guarded.code, guarded.out, guarded.keys]).toEqual([1, "", []]);
    expect(guarded.err).toContain("$(");
    const tokenless = await f.invoke([...thread, "--file", chart], { environment: { CATALY_DISCORD_TOKEN: "" } });
    expect([tokenless.code, tokenless.out, tokenless.err, tokenless.keys]).toEqual([
      1,
      "",
      "CATALY_DISCORD_TOKEN is not set",
      [],
    ]);
  });
}, 120_000);
