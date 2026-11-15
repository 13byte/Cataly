import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { refFromText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

// Inbox files: one JSONL queue per session. A herdr pane keeps the name it had before runtimes existed (`w1_p3.jsonl`),
// so queues written by an older binary drain; every other runtime is prefixed (`hc--t7.jsonl`). A `.forward` file beside
// an inbox (`w1_p3.jsonl.forward`, holding a ref) says that session moved: new messages go to the ref's inbox, and
// entries an older writer still appends to the old file are merged into it by the next flush. A message queued while
// the inbox lock is held waits in `<inbox>.spool/` for the holder (inbox-spool.ts).

const HC_PREFIX = "hc--";
const SUFFIX = ".jsonl";
const SPOOL = ".spool";

export function inboxFile(root: string, ref: SessionRef): string {
  const name = ref.runtime === "herdr" ? ref.id.replaceAll(":", "_") : `${HC_PREFIX}${ref.id}`;
  return join(root, "inbox", `${name}${SUFFIX}`);
}

function refOfFile(name: string): SessionRef {
  const stem = name.slice(0, -SUFFIX.length);
  return stem.startsWith(HC_PREFIX)
    ? { runtime: "hc", id: stem.slice(HC_PREFIX.length) }
    : { runtime: "herdr", id: stem.replaceAll("_", ":") };
}

/** Every session with queued messages, or messages spooled for its queue. */
export const queuedRefs = (root: string): SessionRef[] =>
  [
    ...new Set(
      readdirSync(join(root, "inbox"))
        .map((f) => (f.endsWith(`${SUFFIX}${SPOOL}`) ? f.slice(0, -SPOOL.length) : f))
        .filter((f) => f.endsWith(SUFFIX)),
    ),
  ]
    .map(refOfFile)
    .filter((ref) => {
      const path = inboxFile(root, ref);
      return pendingQueue(path).length > 0 || spooled(path, true).length > 0;
    });

export function readQueue(path: string): QueuedMessage[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as QueuedMessage);
}

export const writeQueue = (path: string, msgs: readonly QueuedMessage[]): void =>
  writeFileSync(path, msgs.map((m) => `${JSON.stringify(m)}\n`).join(""));

export const appendQueue = (path: string, msg: QueuedMessage): void => appendFileSync(path, `${JSON.stringify(msg)}\n`);

// A queued message with an `id` (a duty notice) is queued for a session once: its id is recorded in `<inbox>.ids` when
// it leaves the queue (delivered or acked), so a pass that queues it again after that finds it there. The id is
// recorded before the queue is rewritten without it, and the queue is read without the ids recorded there: a process
// stopped between the two writes leaves an entry that reads as gone, never one delivered a second time.
const idsFile = (path: string): string => `${path}.ids`;

export const doneIds = (path: string): Set<string> =>
  new Set(existsSync(idsFile(path)) ? readFileSync(idsFile(path), "utf8").split("\n").filter(Boolean) : []);

const recordIds = (path: string, ids: readonly string[]): void => {
  if (ids.length > 0) appendFileSync(idsFile(path), ids.map((id) => `${id}\n`).join(""));
};

/** A spooled entry's identity in `<inbox>.ids`: its file name, so a leftover `.moving` file is not queued again. */
export const spoolKey = (name: string): string => `spool:${name}`;

/** The ids `markDone` records for `msgs`: their `id`, and the spool file a spooled entry came through. */
export const doneKeys = (msgs: readonly QueuedMessage[]): string[] =>
  msgs.flatMap((m) => [...(m.id === undefined ? [] : [m.id]), ...(m.spool === undefined ? [] : [spoolKey(m.spool)])]);

export const markDone = (path: string, msgs: readonly QueuedMessage[]): void => recordIds(path, doneKeys(msgs));

/** The session's queue as the flush sees it: entries whose id was recorded as gone are left out. */
export function pendingQueue(path: string): QueuedMessage[] {
  const done = doneIds(path);
  return readQueue(path).filter((m) => m.id === undefined || !done.has(m.id));
}

/** The session this inbox was forwarded to, or undefined. */
export function forwardOf(root: string, ref: SessionRef): SessionRef | undefined {
  const marker = `${inboxFile(root, ref)}.forward`;
  if (!existsSync(marker)) return undefined;
  const text = readFileSync(marker, "utf8").trim();
  return text === "" ? undefined : refFromText(text);
}

/** The old inbox files whose `.forward` marker names `ref`. */
function forwardedInto(root: string, ref: SessionRef): string[] {
  const dir = join(root, "inbox");
  return readdirSync(dir)
    .filter((f) => f.endsWith(`${SUFFIX}.forward`))
    .map((f) => join(dir, f.slice(0, -".forward".length)))
    .filter((old) => {
      const to = readFileSync(`${old}.forward`, "utf8").trim();
      return to !== "" && sameSession(refFromText(to), ref);
    });
}

/** True when ref's inbox has entries to move in: spooled beside it, or in old inboxes forwarded into it. */
export const mergePending = (root: string, ref: SessionRef): boolean =>
  spooled(inboxFile(root, ref), true).length > 0 ||
  forwardedInto(root, ref).some(
    (old) => readQueue(old).length > 0 || readQueue(`${old}.merging`).length > 0 || spooled(old, true).length > 0,
  );

/** An entry's identity: its id; else the spool file it came through (one sent message); else at+from+text. */
const keyOf = (m: QueuedMessage): string =>
  m.id !== undefined
    ? `id:${m.id}`
    : m.spool !== undefined
      ? `spool:${m.spool}`
      : `${m.at}\u0000${m.from}\u0000${m.text}`;

/**
 * Appends the entries of `aside` (a queue renamed aside, its ids still at `<from>.ids`) to the end of `into`, then
 * removes it. The ids `from` recorded as gone are recorded for `into` first and their entries are left behind, so a
 * notice delivered before the move is neither delivered nor queued again after it. An entry `into` already holds under
 * the same key (keyOf), or whose id it recorded as gone, is not added again. Different ids and different spool files
 * remain distinct even when their timestamps and text match.
 */
export function carryOver(aside: string, from: string, into: string, map: (m: QueuedMessage) => QueuedMessage): void {
  const done = doneIds(from);
  const known = doneIds(into);
  recordIds(
    into,
    [...done].filter((id) => !known.has(id)),
  );
  const held = readQueue(into);
  const seen = new Set(held.map(keyOf));
  const ids = new Set([...done, ...known, ...held.flatMap((m) => doneKeys([m]))]);
  for (const m of readQueue(aside)) {
    if ((m.id !== undefined && ids.has(m.id)) || seen.has(keyOf(m))) continue;
    seen.add(keyOf(m));
    for (const key of doneKeys([m])) ids.add(key);
    appendQueue(into, map(m));
  }
  rmSync(aside, { force: true });
}

// Notices for the lead found while no lead is registered (a lost lane's LOST) wait in `duty/lead.jsonl`, a queue of
// their own outside any lane record, so a lane started again under the same key cannot drop one. A message for the
// lead whose route stays held (inbox-spool.ts) waits in that queue's spool, one file per message, so it has no second
// writer of the queue.
export const owedFile = (root: string): string => join(root, "duty", "lead.jsonl");

export function oweLead(root: string, msg: QueuedMessage & { id: string }): void {
  if (!readQueue(owedFile(root)).some((m) => m.id === msg.id)) appendQueue(owedFile(root), msg);
}

/**
 * Moves the owed notices into the lead's inbox `into`, then the messages spooled for the lead, oldest first; call it
 * under into's inbox lock. The queue is renamed aside first, so a run cut short is finished next time.
 */
export function payLead(root: string, into: string): void {
  const owed = owedFile(root);
  const aside = `${owed}.merging`;
  if (existsSync(aside) || existsSync(owed)) {
    if (!existsSync(aside)) renameSync(owed, aside);
    carryOver(aside, owed, into, (m) => m);
  }
  mergeSpool(owed, into);
}

/**
 * Moves the entries of every old inbox forwarded into `ref` to the end of ref's inbox. Call it under ref's inbox lock.
 * The old file is renamed aside first, so an append that races the merge lands in a fresh old file for the next one.
 * The old inbox's spool moves here too: once forwarded, only the holder of the new inbox's lock moves it.
 */
export function mergeForwarded(root: string, ref: SessionRef): void {
  const into = inboxFile(root, ref);
  for (const old of forwardedInto(root, ref)) {
    const aside = `${old}.merging`;
    for (let pass = 0; pass < 2; pass++) {
      if (!existsSync(aside)) {
        try {
          renameSync(old, aside);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
          throw e;
        }
      }
      carryOver(aside, old, into, (m) => m);
    }
    mergeSpool(old, into);
  }
}

export const spoolDir = (path: string): string => `${path}${SPOOL}`;
const MOVING = ".moving";

/** The files spooled for the queue at `path` (`moving`: those a holder renamed aside to move), oldest first. */
function spooled(path: string, moving = false): string[] {
  const dir = spoolDir(path);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(SUFFIX) || (moving && f.endsWith(`${SUFFIX}${MOVING}`)))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Moves the spooled entries of the queue at `from` to the end of `into`, oldest first, under into's lock. A spooled
 * entry is a message of its own, so it is appended even when an equal one is queued (the same text sent twice in one
 * millisecond stays two messages); only ids recorded as gone are skipped. Each file is renamed aside before its entry
 * is appended and removed after: a `.moving` file left by a move cut short between the two may already be in `into`,
 * and is carried over (skipping it if `into` holds an entry from the same spool file) before the rest. A `.moving`
 * file whose entry already left `into` (`<into>.ids` holds its spool name) is removed without being appended again.
 */
export function mergeSpool(from: string, into: string): void {
  const gone = new Set([...doneIds(from), ...doneIds(into)]);
  for (const f of spooled(from, true).filter((n) => n.endsWith(MOVING))) {
    const name = basename(f)
      .slice(0, -MOVING.length)
      .replace(/\.jsonl$/, "");
    if (gone.has(spoolKey(name))) {
      rmSync(f, { force: true });
      continue;
    }
    carryOver(f, from, into, (m) => m);
  }
  for (const file of spooled(from)) {
    renameSync(file, `${file}${MOVING}`);
    for (const m of readQueue(`${file}${MOVING}`)) if (m.id === undefined || !gone.has(m.id)) appendQueue(into, m);
    rmSync(`${file}${MOVING}`, { force: true });
  }
}
