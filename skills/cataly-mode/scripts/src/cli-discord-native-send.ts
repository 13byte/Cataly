import { isAbsolute } from "node:path";
import { isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";
import { incompleteReplyReceipt } from "./messenger/discord-response.ts";
import { DeliveryUncertainError, MessengerError } from "./messenger/http.ts";

/** A file its path gate admitted: the native sender posts it only while its bytes still have this size and hash. */
export type AdmittedFile = { readonly path: string; readonly size: number; readonly sha256: string };
type SentFile = { readonly id: string; readonly filename: string; readonly size: number; readonly sha256: string };

/** The receipt entries that name each sent file with exactly its admitted size and hash, in order. */
const sentFiles = (receipt: object, files: readonly AdmittedFile[]): SentFile[] => {
  const listed: unknown = "attachments" in receipt ? receipt.attachments : [];
  if (!Array.isArray(listed) || listed.length !== files.length) return [];
  return listed.flatMap((entry: unknown, index) => {
    if (entry === null || typeof entry !== "object") return [];
    const { id, filename, size, sha256 } = entry as Record<string, unknown>;
    const file = files[index]!;
    const named = isDiscordSnowflake(id) && typeof filename === "string" && filename !== "";
    return named && size === file.size && sha256 === file.sha256 ? [{ id, filename, size, sha256 }] : [];
  });
};

export async function nativeDiscordSend(
  binary: string,
  target: { readonly to: string } | { readonly thread: string },
  options: {
    readonly text: string;
    readonly edit: string | undefined;
    readonly reply: string | undefined;
    readonly files?: readonly AdmittedFile[];
  },
): Promise<{
  readonly channel: string;
  readonly ids: string[];
  readonly replyConfirmed: boolean;
  readonly files: SentFile[];
}> {
  if (!isAbsolute(binary)) throw new Error("CATALY_DISCORD_NATIVE_BIN must be absolute");
  const files = options.files ?? [];
  const argv = [binary, "discord-send", ...("thread" in target ? ["--thread", target.thread] : ["--to", target.to])];
  if (options.edit !== undefined) argv.push("--edit", options.edit);
  if (options.reply !== undefined) argv.push("--reply", options.reply);
  for (const file of files) argv.push("--file", `${file.sha256}:${file.size}:${file.path}`);
  const child = Bun.spawn(argv, { stdin: new TextEncoder().encode(options.text), stdout: "pipe", stderr: "inherit" });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0 && files.length === 0) throw new Error(`Native Discord send exited with status ${code}`);
  // With files, status 1 or 2 refused the request and posted nothing. Status 3 is an unconfirmed delivery, and a
  // signal or crash can follow an accepted request just as well: none of those is ever sent again.
  if (code === 1 || code === 2)
    throw new MessengerError(
      `discord send --file: the native sender refused the request (status ${code}); nothing was posted`,
      0,
    );
  if (code !== 0) throw new DeliveryUncertainError("discord send --file");
  const result: unknown = JSON.parse(output);
  if (
    !result ||
    typeof result !== "object" ||
    !("channel" in result) ||
    !isDiscordSnowflake(result.channel) ||
    !("ids" in result) ||
    !Array.isArray(result.ids) ||
    !result.ids.every(isDiscordSnowflake) ||
    !("replyConfirmed" in result) ||
    typeof result.replyConfirmed !== "boolean" ||
    (options.reply === undefined && result.replyConfirmed) ||
    (options.edit === undefined ? result.ids.length === 0 : result.ids.length !== 0) ||
    ("thread" in target && result.channel !== target.thread) ||
    ("to" in target && /^\d+$/.test(target.to) && result.channel !== target.to)
  ) {
    if (files.length > 0) throw incompleteReplyReceipt([]);
    throw new Error("Invalid native Discord delivery receipt; inspect the destination before retrying");
  }
  const sent = sentFiles(result, files);
  // The message exists, but its receipt does not show every admitted file: uncertain, and never posted again.
  if (files.length > 0 && (result.ids.length !== 1 || sent.length !== files.length))
    throw incompleteReplyReceipt(result.ids);
  return { channel: result.channel, ids: result.ids, replyConfirmed: result.replyConfirmed, files: sent };
}
