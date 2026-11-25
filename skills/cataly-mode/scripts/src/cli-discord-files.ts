/** `cataly send discord --file`: the artifact gate admits each file here; the native sender verifies and posts it. */
import type { ArtifactRoot } from "./artifact-config.ts";
import { ArtifactError, inspectArtifact } from "./artifact-files.ts";
import { type Command, die, messageText } from "./cli-context.ts";
import { discordNativeBinary } from "../../../../src/native-binary.ts";
import { type AdmittedFile, nativeDiscordSend } from "./cli-discord-native-send.ts";
import { confirmDiscordSend } from "./cli-discord-ops.ts";
import { discordInboundEnv } from "./messenger/discord-inbound-state.ts";
import { renderDiscordTables } from "./messenger/discord-markdown.ts";
import { guardText, MessengerError } from "./messenger/http.ts";
import { DISCORD_LIMIT } from "./messenger/split.ts";

/**
 * Discord's 10 attachments per message and its documented 20 MiB per file. Together the files may have 24 MiB: its
 * 25 MiB request limit less the 1 MiB the native sender keeps for the text and the multipart framing.
 */
const LIMITS = { count: 10, fileBytes: 20 * 1024 * 1024, totalBytes: 24 * 1024 * 1024 } as const;

const NATIVE_REQUIRED =
  "send discord --file requires the native Cataly binary; nothing was sent. Build it with " +
  "`cargo build --locked --release` and set CATALY_DISCORD_NATIVE_BIN to the absolute path of target/release/cataly, " +
  "or reinstall Cataly on a host with a Rust toolchain so it installs $CATALY_HOME/bin/cataly-native.";

/**
 * Admits each path through the artifact gate: an explicit `artifactRoots` root holds it lexically and physically, no
 * component is hidden, sensitive or a dependency directory, its type is listed, and it is a regular file that stayed
 * unchanged while its SHA-256 was streamed. Count and sizes are refused before a file's first byte is read, and a
 * refused file is named by its path as given.
 */
const admitFiles = async (roots: readonly ArtifactRoot[], paths: readonly string[]): Promise<AdmittedFile[]> => {
  if (paths.length > LIMITS.count)
    throw new MessengerError(`discord send: one message carries at most ${LIMITS.count} files, not ${paths.length}`, 0);
  const files: AdmittedFile[] = [];
  let total = 0;
  for (const path of paths) {
    try {
      const file = await inspectArtifact(roots, path, "private", (size) => {
        if (size === 0) throw new ArtifactError("the file is empty");
        if (size > LIMITS.fileBytes)
          throw new ArtifactError(`${size} bytes exceed the ${LIMITS.fileBytes}-byte limit per file`);
        if (total + size > LIMITS.totalBytes)
          throw new ArtifactError(`the files exceed the ${LIMITS.totalBytes}-byte limit per message`);
      });
      total += file.size;
      files.push({ path: file.path, size: file.size, sha256: file.sha256 });
    } catch (error) {
      if (!(error instanceof ArtifactError)) throw error;
      throw new MessengerError(`discord send: file ${JSON.stringify(path)}: ${error.message}`, 0);
    }
  }
  return files;
};

export const sendDiscordWithFiles: Command = async (cli) => {
  const { need, opt, values, config } = cli;
  const given = values["file"];
  const paths = Array.isArray(given) ? given : [given];
  // A bare or empty --file is refused before any request: it must never become a send without its file.
  if (!paths.every((path): path is string => typeof path === "string" && path !== ""))
    return die("--file needs a path");
  // A file belongs to a new message; an edit must never post one.
  if (values["edit"] !== undefined) die("--file makes a new message; it cannot be used with --edit");
  const thread = opt("thread");
  const destination = thread === undefined ? { to: need("to") } : { thread: discordInboundEnv("--thread", thread) };
  const reply = values["reply"] === undefined ? undefined : discordInboundEnv("--reply", opt("reply"));
  // Text is optional beside a file. It stays in the one message with the files, so it is never split.
  const rawText = values["text"] === undefined && values["text-file"] === undefined ? "" : await messageText(cli);
  const text = guardText(values["render-tables"] === true ? renderDiscordTables(rawText, 64 * 1024) : rawText);
  if (text.length > DISCORD_LIMIT)
    die(`--file text exceeds ${DISCORD_LIMIT} UTF-16 code units; shorten the text or send it without --file`);
  if (!process.env["CATALY_DISCORD_TOKEN"]) die("CATALY_DISCORD_TOKEN is not set");
  // Only the native sender uploads. Without it the send is refused here, never degraded to a text-only message.
  const native = discordNativeBinary() ?? die(NATIVE_REQUIRED);
  const files = await admitFiles(config.artifactRoots ?? [], paths);
  const sent = await nativeDiscordSend(native, destination, { text, edit: undefined, reply, files });
  await confirmDiscordSend(
    config,
    { reply, target: sent.channel, ids: sent.ids, replyConfirmed: sent.replyConfirmed, rawText },
    undefined,
    sent.files.map((file) => `SENT_ATTACHMENT discord ${sent.channel} ${sent.ids[0]} ${JSON.stringify(file)}`),
  );
};
