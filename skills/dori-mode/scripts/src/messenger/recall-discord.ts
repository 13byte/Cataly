import type { DoriConfig } from "../config.ts";
import { type Discord, isThreadType } from "./discord.ts";
import type { DiscordInbound } from "./discord-inbound-api.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";
import { conversationRecall, createRecallScope } from "./recall-ledger.ts";

const warn = (message: string) => console.error(`WARN ${message}`);

export const discordOwnerRecall = (config: DoriConfig, identity: { bot: string; owner: string }) => {
  const recall = conversationRecall(
    { ...config, scope: createRecallScope("discord", identity.bot, identity.owner) },
    warn,
  );
  return (message: DiscordInbound, space: () => string | undefined): string | undefined => {
    if (!recall || message.text.trim() === "") return undefined;
    let channel: string | undefined;
    try {
      channel = space();
    } catch {
      warn("recall: Discord conversation scope was not available");
      return undefined;
    }
    if (channel === undefined) return undefined;
    return recall.owner({ channel, thread: message.channel, ref: message.message, text: message.text });
  };
};

/** A send receipt alone does not establish either the authenticated bot or the target's conversation space. */
export const discordLeadRecall = async (
  config: DoriConfig,
  discord: Discord,
  thread: string,
  ids: readonly string[],
  text: string,
): Promise<void> => {
  if (config.recall?.enabled !== true || ids.length === 0 || !ids.every(isDiscordSnowflake)) return;
  const env = process.env;
  const owner = env["DORI_DISCORD_OWNER_ID"]?.trim();
  const threads = env["DORI_DISCORD_THREADS"]?.trim().toLowerCase();
  if (!isDiscordSnowflake(owner) || env["DORI_DISCORD_SCOPE"]?.trim() || (threads && threads !== "on")) return;
  const explicit = [env["DORI_DISCORD_CHANNEL_ID"], env["DORI_DISCORD_CHANNEL_IDS"]]
    .flatMap((value) => (value ?? "").split(","))
    .map((value) => value.trim())
    .filter(isDiscordSnowflake);
  if (explicit.length === 0) return;
  try {
    const target = await discord.channel(thread);
    if (target?.id !== thread || !Number.isSafeInteger(target.type)) return;
    const channel = isThreadType(target.type) ? target.parent_id : thread;
    if (!isDiscordSnowflake(channel) || !explicit.includes(channel)) return;
    const me = await discord.call<{ id?: unknown; bot?: unknown }>("GET", "/users/@me");
    if (me?.bot !== true || !isDiscordSnowflake(me.id) || me.id === owner) return;
    conversationRecall({ ...config, scope: createRecallScope("discord", me.id, owner) }, warn)?.lead({
      channel,
      thread,
      ref: ids.join(" "),
      text,
    });
  } catch {
    warn("recall: Discord delivery identity or scope was not available");
  }
};
