import { expect, test } from "bun:test";
import { symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sentReceipts } from "../src/owes.ts";
import { ids } from "./discord-fakes.ts";
import { sha256, withFilesCli } from "./discord-files-fixture.ts";
import { nativeDiscordBinary } from "./discord-loopback.ts";

// The Rust sender posts every request here; without the binary these are skipped, never faked.
const native = nativeDiscordBinary();
const withNative = test.skipIf(process.platform === "win32" || !native);
const environment = { CATALY_DISCORD_NATIVE_BIN: native ?? "" };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const notes = "# result\n";
const post = `POST /channels/${ids.thread}/messages`;
const thread = ["send", "discord", "--thread", ids.thread];
const reply = [...thread, "--reply", ids.message];
const refused = "discord send --file: the native sender refused the request (status 1); nothing was posted";
const uncertain =
  "discord send --file: delivery uncertain; the request may have succeeded; do not resend. Inspect the original remote target and reconcile its IDs before retrying.";

withNative(
  "the native sender posts one multipart reply and every attachment gets a receipt",
  async () => {
    await withFilesCli(async (f) => {
      const chart = f.file("chart.png", png);
      const report = f.file("notes/\uacb0\uacfc (v1).md", notes);
      const r = await f.invoke([...reply, "--text", "two files", "--file", chart, "--file", report], { environment });
      expect([r.code, r.err]).toEqual([0, ""]);
      expect(r.out.split("\n")).toEqual([
        "SENT 71",
        `SENT_ATTACHMENT discord ${ids.thread} 71 {"id":"900","filename":"chart.png","size":${png.length},"sha256":"${sha256(png)}"}`,
        `SENT_ATTACHMENT discord ${ids.thread} 71 {"id":"901","filename":"\uacb0\uacfc (v1).md","size":${notes.length},"sha256":"${sha256(notes)}"}`,
      ]);
      expect(r.keys).toEqual([post]);
      expect(r.uploads).toHaveLength(1);
      const upload = r.uploads[0];
      expect(upload?.authorization).toBe("Bot synthetic-ops-token");
      expect(upload?.type).toMatch(/^multipart\/form-data; boundary=cataly-[0-9a-f]{32}$/);
      expect(upload?.payload).toEqual({
        content: "two files",
        allowed_mentions: { parse: [], replied_user: false },
        message_reference: { message_id: ids.message, channel_id: ids.thread, fail_if_not_exists: true },
        nonce: expect.stringMatching(/^[0-9a-f]{24}$/),
        enforce_nonce: true,
        attachments: [
          { id: 0, filename: "chart.png" },
          { id: 1, filename: "\uacb0\uacfc (v1).md" },
        ],
      });
      // The receipt hash is the hash of the bytes the server received.
      expect(upload?.parts).toEqual([
        { field: "files[0]", filename: "chart.png", size: png.length, sha256: sha256(png) },
        { field: "files[1]", filename: "\uacb0\uacfc (v1).md", size: notes.length, sha256: sha256(notes) },
      ]);
      expect(sentReceipts(f.stateDir)).toEqual([
        expect.objectContaining({ channel: ids.thread, requestId: `${ids.thread}:${ids.message}`, remoteIds: ["71"] }),
      ]);
    });
  },
  60_000,
);

withNative(
  "files need no text, --to resolves like a text send, and a forum is refused before posting",
  async () => {
    await withFilesCli(async (f) => {
      const chart = f.file("chart.png", png);
      const sent = await f.invoke(["send", "discord", "--to", ids.text, "--file", chart], { environment });
      expect([sent.code, sent.err, sent.keys]).toEqual([
        0,
        "",
        [`GET /channels/${ids.text}`, `POST /channels/${ids.text}/messages`],
      ]);
      expect(sent.out.split("\n")[0]).toBe("SENT 71");
      expect(sent.out).toContain(`SENT_ATTACHMENT discord ${ids.text} 71 {"id":"900","filename":"chart.png"`);
      expect(Object.keys(sent.uploads[0]?.payload ?? {}).sort()).toEqual([
        "allowed_mentions",
        "attachments",
        "enforce_nonce",
        "nonce",
      ]);
      const forum = await f.invoke(["send", "discord", "--to", ids.forum, "--file", chart], { environment });
      expect([forum.code, forum.out, forum.keys]).toEqual([1, "", [`GET /channels/${ids.forum}`]]);
      expect(forum.err).toContain("Discord forum/media channels require an explicit thread");
      expect(forum.err).toEndWith(refused);
      // An alias inside the root is sent under the name the operator gave.
      const alias = join(f.root, "latest.png");
      symlinkSync(chart, alias);
      const aliased = await f.invoke([...thread, "--file", alias], { environment });
      expect([aliased.code, aliased.err]).toEqual([0, ""]);
      expect(aliased.uploads[0]?.parts).toEqual([
        { field: "files[0]", filename: "latest.png", size: png.length, sha256: sha256(png) },
      ]);
    });
  },
  60_000,
);

withNative(
  "a reply Discord does not confirm settles no owner request, and a missing target posts nothing",
  async () => {
    await withFilesCli(async (f) => {
      const args = [...reply, "--file", f.file("chart.png", png)];
      const attachments = [{ id: "900", filename: "chart.png", size: png.length }];
      const plain = { id: "71", channel_id: ids.thread, attachments };
      const r = await f.invoke(args, { environment, answers: [{ body: plain }] });
      expect([r.code, r.err, r.out.split("\n").length]).toEqual([0, "", 2]);
      expect(sentReceipts(f.stateDir)).toEqual([]);
      // A deleted or other-channel target is rejected atomically: nothing is posted unlinked.
      const gone = await f.invoke(args, {
        environment,
        answers: [{ status: 400, body: { code: 10008, message: "Unknown Message" } }],
      });
      expect([gone.code, gone.out, gone.keys]).toEqual([1, "", [post]]);
      expect(gone.err).toContain("Discord rejected the file message; nothing was posted");
      expect(gone.err).toContain("Discord REST returned HTTP 400");
      expect(gone.err).toEndWith(refused);
    });
  },
  60_000,
);

withNative(
  "a rate-limited upload is retried once with the same nonce and the same bytes",
  async () => {
    await withFilesCli(async (f) => {
      const args = [...thread, "--file", f.file("chart.png", png)];
      const limited = { status: 429, body: { message: "You are being rate limited.", retry_after: 0.05 } };
      const r = await f.invoke(args, { environment, answers: [limited] });
      expect([r.code, r.err, r.keys]).toEqual([0, "", [post, post]]);
      expect(r.uploads.map((upload) => upload.payload["enforce_nonce"])).toEqual([true, true]);
      expect(r.uploads[1]?.payload["nonce"]).toBe(r.uploads[0]?.payload["nonce"]);
      expect(r.uploads[1]?.parts).toEqual(r.uploads[0]?.parts ?? []);
      const next = await f.invoke(args, { environment });
      expect(next.uploads[0]?.payload["nonce"]).not.toBe(r.uploads[0]?.payload["nonce"]);
      // A second 429 is a rejection: the request is not sent a third time.
      const twice = await f.invoke(args, { environment, answers: [limited, limited] });
      expect([twice.code, twice.out, twice.keys]).toEqual([1, "", [post, post]]);
      expect(twice.err).toEndWith(refused);
    });
  },
  60_000,
);

withNative(
  "an unconfirmed upload is reported as uncertain and is never sent again",
  async () => {
    await withFilesCli(async (f) => {
      const args = [...thread, "--file", f.file("chart.png", png)];
      const one = [{ id: "900", filename: "chart.png", size: png.length }];
      const unlisted = "Discord posted message 71 without confirming every file";
      const cases: [status: number, body: unknown, detail: string][] = [
        [500, { message: "Internal Server Error" }, "Discord REST returned HTTP 500"],
        [200, { id: "71", channel_id: ids.thread, attachments: [] }, unlisted],
        [200, { id: "71", channel_id: ids.thread, attachments: [{ ...one[0], size: png.length + 1 }] }, unlisted],
        [200, { id: "71", channel_id: ids.text, attachments: one }, "Discord returned message 71 in another channel"],
        [200, {}, "Discord did not confirm the posted message"],
      ];
      for (const [status, body, detail] of cases) {
        const r = await f.invoke(args, { environment, answers: [{ status, body }] });
        expect([r.code, r.out, r.keys]).toEqual([1, "", [post]]);
        expect(r.err).toContain(`Discord file delivery was not confirmed: ${detail}`);
        expect(r.err).toContain("inspect the destination and do not resend");
        expect(r.err).toEndWith(uncertain);
      }
      expect(sentReceipts(f.stateDir)).toEqual([]);
    });
  },
  60_000,
);

withNative(
  "the native sender refuses bytes that changed after the gate admitted them",
  async () => {
    await withFilesCli(async (f) => {
      const chart = f.file("chart.png", png);
      // A sender that sees another file than the gate saw: same size, different bytes, then the real binary.
      const racing = join(f.stateDir, "racing-native");
      writeFileSync(racing, `#!/bin/sh\nprintf 'changed%s' 1234 > '${chart}'\nexec '${native}' "$@"\n`, {
        mode: 0o700,
      });
      const r = await f.invoke([...thread, "--file", chart], { environment: { CATALY_DISCORD_NATIVE_BIN: racing } });
      expect([r.code, r.out, r.keys]).toEqual([1, "", []]);
      expect(r.err).toContain(`Discord file ${chart} changed after it was admitted; nothing was sent`);
      expect(r.err).toEndWith(refused);
    });
  },
  60_000,
);

withNative(
  "ten files, and files at exactly the per-file and the combined limit, fit one request",
  async () => {
    await withFilesCli(async (f) => {
      const parts = Array.from({ length: 10 }, (_, index) => f.file(`part-${index}.txt`, `part ${index}\n`));
      const ten = await f.invoke([...thread, ...parts.flatMap((path) => ["--file", path])], { environment });
      expect([ten.code, ten.err, ten.keys]).toEqual([0, "", [post]]);
      expect(ten.uploads[0]?.parts.map((part) => part.field)).toEqual(parts.map((_, index) => `files[${index}]`));
      expect(ten.out.split("\n")).toHaveLength(11);
      // 20 MiB is Discord's limit per file; 20 MiB + 4 MiB is the 24 MiB that files may have together.
      const mib = 1024 * 1024;
      const full = f.file("full.mp4", "");
      truncateSync(full, 20 * mib);
      const rest = f.file("rest.mp4", "");
      truncateSync(rest, 4 * mib);
      const sent = await f.invoke([...reply, "--text", "t".repeat(2000), "--file", full, "--file", rest], {
        environment,
      });
      expect([sent.code, sent.err, sent.keys]).toEqual([0, "", [post]]);
      expect(sent.uploads[0]?.parts.map((part) => part.size)).toEqual([20 * mib, 4 * mib]);
      // The request also carries the longest text and the multipart framing, and stays under Discord's 25 MiB.
      const request = sent.uploads[0]?.requestBytes ?? 0;
      expect(request).toBeGreaterThan(24 * mib + 2000);
      expect(request).toBeLessThan(25 * mib);
    });
  },
  120_000,
);
