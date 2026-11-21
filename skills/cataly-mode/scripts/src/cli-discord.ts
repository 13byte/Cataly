/** The Discord Gateway plumbing shared by `cataly presence discord` and `cataly inbound discord --gateway`. */
import { join } from "node:path";
import { inboundActivity, InboundActivityError } from "../../../../src/update/source-activity.ts";
import { takeLock } from "./checkpoint-lock.ts";
import { die, every, exitOnDisconnect } from "./cli-context.ts";
import { discordClock, openDiscordSocket, untilStopped } from "./cli-discord-gateway.ts";
import { discordLaneMonitor } from "./discord-lane-monitor.ts";
import type { FlowDeps } from "./done-flow.ts";
import { Discord, discordApiBase } from "./messenger/discord.ts";
import { DiscordChannels } from "./messenger/discord-channels.ts";
import { routeDiscordAskReply, routeUnreferencedDiscordAskText } from "./messenger/discord-ask-mailbox.ts";
import { type DiscordAskReceiverPublication, openDiscordAskReceiver } from "./messenger/discord-ask-receiver.ts";
import {
  discordInbound,
  formatDiscordInbound,
  formatInboundContext,
  markDiscordInboundSeen,
} from "./messenger/discord-inbound.ts";
import { inboundContext } from "./messenger/discord-inbound-context.ts";
import { type Emit, isOwnerMessage, transientRetryDelay } from "./messenger/discord-inbound-api.ts";
import { discordInboundLive } from "./messenger/discord-inbound-live.ts";
import { discordInboundQueue } from "./messenger/discord-inbound-queue.ts";
import { discordInboundEnv } from "./messenger/discord-inbound-state.ts";
import { openDiscordLaneInbox } from "./messenger/discord-lane-inbox.ts";
import { DiscordLaneIntakeHold, enqueueDiscordLane } from "./messenger/discord-lane-routing.ts";
import { headEmitter, reconcileHead } from "./messenger/head-admission.ts";
import { headUnresolved } from "./messenger/head-admission-state.ts";
import { fetchHttp } from "./messenger/http.ts";
import { recordOwes } from "./owes.ts";
import { realClock } from "./run.ts";
const idList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");

export const discordInboundCommand = async (
  deps: FlowDeps,
  options: {
    readonly gateway: boolean;
    readonly pollMinutes: number;
    readonly context: boolean;
    readonly wake: boolean;
    readonly activityFile?: string;
  },
) => {
  const { gateway, pollMinutes, context, wake } = options;
  const { stateDir } = deps.config;
  if (wake && (gateway || pollMinutes <= 0)) die("--wake-lanes requires continuous Discord REST intake");
  const env = process.env;
  const ownerId = discordInboundEnv("CATALY_DISCORD_OWNER_ID", env["CATALY_DISCORD_OWNER_ID"]);
  const scope = env["CATALY_DISCORD_SCOPE"]?.trim();
  if (scope !== undefined && scope !== "" && scope !== "all") die("CATALY_DISCORD_SCOPE must be all or unset");
  const all = scope === "all";
  const setting = env["CATALY_DISCORD_THREADS"]?.trim().toLowerCase();
  if (setting !== undefined && setting !== "" && setting !== "off" && setting !== "on")
    die("CATALY_DISCORD_THREADS must be on, off or unset");
  const threads = setting !== "off";
  const channelIds = ["CATALY_DISCORD_CHANNEL_ID", "CATALY_DISCORD_CHANNEL_IDS"].flatMap((name) =>
    idList(env[name]).map((id) => discordInboundEnv(name, id)),
  );
  if (!all && channelIds.length === 0) discordInboundEnv("CATALY_DISCORD_CHANNEL_ID", env["CATALY_DISCORD_CHANNEL_ID"]);
  const token = env["CATALY_DISCORD_TOKEN"] || die("CATALY_DISCORD_TOKEN is not set");
  const mode = env["CATALY_MONITOR_ADMISSION"];
  const native = mode === "1";
  if (mode !== undefined && (!native || !process.send || !process.connected)) throw headUnresolved();
  const queue = discordInboundQueue(stateDir, native);
  const delivery = { registry: deps.registry, clock: realClock };
  let receiver: DiscordAskReceiverPublication | undefined;
  let laneInbox: ReturnType<typeof openDiscordLaneInbox> | undefined;
  let releaseWake: (() => void) | undefined;
  let activity: ReturnType<typeof inboundActivity>;
  const close = () => {
    try {
      activity?.close();
    } finally {
      releaseWake?.();
      receiver?.close();
      laneInbox?.close();
      queue.close();
    }
  };
  const unregisterDisconnect = native ? exitOnDisconnect(close) : undefined;
  try {
    if (wake) {
      const lock = takeLock(join(stateDir, "discord-lane-monitor.lock"), realClock.now(), (text) => new Error(text), {
        keepLiveOwner: true,
      });
      if (typeof lock !== "function")
        return die("Another Discord lane wake monitor is running for this state directory");
      releaseWake = lock;
    }
    await reconcileHead(queue);
    if (!gateway && queue.first())
      die("Discord inbound has pending Gateway work; restart with --gateway before REST mode");
    activity = inboundActivity(options.activityFile, "discord");
    const apiOverride = env["CATALY_DISCORD_API_BASE"] ?? "";
    const discord = new Discord(fetchHttp, realClock, token, discordApiBase(apiOverride));
    const intake = await discordInbound(discord, queue.storeFor, {
      ownerId,
      channelIds: [...new Set(channelIds)],
      all,
      threads,
    });
    const identity = { bot: intake.botId, owner: ownerId };
    const serviceLanes = wake ? discordLaneMonitor(deps, discord, identity) : undefined;
    if (wake) laneInbox = openDiscordLaneInbox(stateDir);
    if (gateway || pollMinutes > 0)
      receiver = openDiscordAskReceiver(stateDir, token, ownerId, channelIds, intake.channels, {
        progressWindowMs: gateway ? Infinity : pollMinutes * 60_000 + 15_000,
        apiOverride,
      });
    const watching = all ? "all" : intake.channels().join(",");
    const where = context ? inboundContext(discord, new DiscordChannels(stateDir), realClock.now) : undefined;
    const recall = deps.config.recall?.enabled
      ? await import("./messenger/recall-discord.ts").then((module) => module.discordOwnerRecall(deps.config, identity))
      : undefined;
    const emitToHead = headEmitter(queue, intake.botId, ownerId, async (message, signal) => {
      const text = where
        ? `${formatDiscordInbound(message)}\n${formatInboundContext(message, await where(message.channel))}`
        : formatDiscordInbound(message);
      await recordOwes(stateDir, text, Date.now(), signal);
      signal?.throwIfAborted();
      const recalled = recall?.(message, () =>
        intake.recallSpaceFor(message.channel, queue.parentFor(message.channel)),
      );
      return recalled ? `${text}\n${recalled}` : text;
    });
    const emit: Emit = async (message, signal) => {
      signal?.throwIfAborted();
      activity?.received();
      if (
        routeDiscordAskReply(stateDir, message, ownerId) ||
        (message.unreferencedText && routeUnreferencedDiscordAskText(stateDir, message, ownerId))
      ) {
        await markDiscordInboundSeen(discord, message);
        return;
      }
      const queued = await enqueueDiscordLane(
        delivery,
        stateDir,
        message.channel,
        wake,
        (session) => {
          laneInbox ??= openDiscordLaneInbox(stateDir);
          if (wake) laneInbox.add(session, message, { reply: identity });
          else laneInbox.add(session, message);
        },
        signal,
      );
      if (queued) {
        await markDiscordInboundSeen(discord, message);
        return;
      }
      await emitToHead(message, signal);
    };
    console.log(
      `INBOUND_READY discord owner=${ownerId} channel=${watching} bot=${intake.botId}${gateway ? " mode=gateway" : ""}`,
    );
    if (!gateway)
      return await every(
        pollMinutes,
        async () => {
          await intake.poll(emit);
          receiver?.refresh();
          if (serviceLanes && laneInbox) await serviceLanes(laneInbox, intake.channels());
          activity?.healthy();
        },
        (error, interval) => {
          receiver?.suspend();
          if (error instanceof InboundActivityError) return false;
          activity?.unavailable();
          return error instanceof DiscordLaneIntakeHold ? interval : (transientRetryDelay(error, interval) ?? false);
        },
      );
    // Gateway receipts mean successful backfill on the observed connection, not a separate connectivity probe.
    let connected = false;
    let generation = 0;
    const live = {
      ...intake,
      async sync(...args: Parameters<typeof intake.sync>) {
        const current = generation;
        try {
          await intake.sync(...args);
          if (connected && current === generation) receiver?.refresh();
        } catch (error) {
          receiver?.suspend();
          throw error;
        }
      },
    };
    await untilStopped(
      discordInboundLive(
        live,
        openDiscordSocket,
        token,
        discordClock,
        emit,
        (line) => console.log(line),
        queue,
        {
          ready() {
            connected = true;
            generation++;
          },
          disconnect() {
            connected = false;
            generation++;
            receiver?.suspend();
          },
        },
        activity && {
          healthy: activity.healthy,
          unavailable: activity.unavailable,
          received: (message) => {
            if (isOwnerMessage(message, ownerId, intake.botId)) activity?.received();
          },
        },
      ),
    );
  } finally {
    unregisterDisconnect?.();
    close();
  }
};
