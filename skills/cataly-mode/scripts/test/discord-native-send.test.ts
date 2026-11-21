import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sentReceipts } from "../src/owes.ts";
import { ids, withDiscordCli } from "./discord-fakes.ts";

test.skipIf(process.platform === "win32")(
  "native send settles only a confirmed reply without reposting in Bun",
  async () => {
    await withDiscordCli(async (f) => {
      const bin = join(f.tmp, "native-cataly");
      writeFileSync(
        bin,
        `#!${process.execPath}
const [command, destination, channel, reply, message] = process.argv.slice(2);
const input = await Bun.stdin.text();
if (command !== "discord-send" || destination !== "--thread" || reply !== "--reply" || input !== "answer from stdin") process.exit(91);
console.log(JSON.stringify({ channel, ids: [message === "50" ? "71" : "72"], replyConfirmed: message === "50" }));
`,
        { mode: 0o700 },
      );
      for (const [message, remote] of [
        [ids.message, "71"],
        [ids.starter, "72"],
      ] as const) {
        const r = await f.invoke(["send", "discord", "--thread", ids.thread, "--reply", message, "--text-file", "-"], {
          stdin: "answer from stdin\n",
          environment: { CATALY_DISCORD_NATIVE_BIN: bin },
        });
        expect([r.code, r.out, r.keys]).toEqual([0, `SENT ${remote}`, []]);
      }
      expect(sentReceipts(join(f.tmp, ".."))).toEqual([
        expect.objectContaining({ channel: ids.thread, requestId: `${ids.thread}:${ids.message}`, remoteIds: ["71"] }),
      ]);
    });
  },
  25_000,
);
