import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendQueue, forwardOf, inboxFile, mergeSpool, spoolDir } from "./inbox-files.ts";
import { takeInboxLock } from "./inbox-lock.ts";
import { refText } from "./refs.ts";
import { Refusal } from "./refusal.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

// A message queued while another process holds the inbox lock is written to a file of its own in `<inbox>.spool/`, and
// the holder of the lock moves it into the queue. A holder rewrites the queue from what it read, so an append beside it
// would be lost; one file per message means nothing it moves can still be written to. The entry keeps the file's name
// (`spool`), so a move cut short adds it once and an equal message stays a message of its own.

const ROUTE_TRIES = 40;
const ROUTE_RETRY_MS = 50;
let spoolSeq = 0;

/** Spools `msg` for the queue at `path` in a file of its own, written aside and renamed in whole. */
function spoolMessage(path: string, msg: QueuedMessage): void {
  mkdirSync(spoolDir(path), { recursive: true });
  const name = `${String(msg.at).padStart(15, "0")}-${String(spoolSeq++).padStart(9, "0")}-${randomUUID()}`;
  const file = join(spoolDir(path), `${name}.jsonl`);
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...msg, spool: name })}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * Moves ref's spool into its queue; call it under ref's inbox lock, before the queue is read and after it is rewritten.
 * Not while a `.forward` marker names another inbox: the holder of that inbox's lock moves it then (mergeForwarded), so
 * no spooled file has two movers at once.
 */
export function mergeOwnSpool(root: string, ref: SessionRef): void {
  const path = inboxFile(root, ref);
  if (forwardOf(root, ref) === undefined) mergeSpool(path, path);
}

/** Takes ref's inbox lock (see Store.lockInbox) and moves its spool into the queue before anything reads it. */
export function lockQueue(root: string, ref: SessionRef, now: number): (() => void) | undefined {
  const release = takeInboxLock(`${inboxFile(root, ref)}.lock`, now);
  if (!release) return undefined;
  try {
    mergeOwnSpool(root, ref);
  } catch (e) {
    release();
    throw e;
  }
  return release;
}

/**
 * Takes the route lock of ref's inbox (`<inbox>.route`, judged stale like the inbox lock). A sender holds it from
 * reading the `.forward` marker to writing its message, and a migration while it writes, drains or removes the marker
 * (migrate-inbox.ts), so a message is never written where the marker it read no longer points.
 */
export function lockRoute(root: string, ref: SessionRef, now: number): (() => void) | undefined {
  return takeInboxLock(`${inboxFile(root, ref)}.route`, now);
}

/** Appends `msg` to ref's queue under its lock; while another process holds the lock, spools it for that holder. */
function appendOrSpool(root: string, ref: SessionRef, msg: QueuedMessage): void {
  const release = lockQueue(root, ref, msg.at);
  if (!release) {
    spoolMessage(inboxFile(root, ref), msg);
    return;
  }
  try {
    appendQueue(inboxFile(root, ref), msg);
  } finally {
    release();
  }
}

/**
 * Queues `msg` in the inbox ref was forwarded to, if it was, else in ref's own, under ref's route lock. A migration
 * holds the route only while it moves files, so a held route is waited for briefly, then the send is refused.
 */
export function queueMessage(root: string, ref: SessionRef, msg: QueuedMessage): void {
  for (let tries = 0; ; tries++) {
    const route = lockRoute(root, ref, msg.at);
    if (route) {
      try {
        appendOrSpool(root, forwardOf(root, ref) ?? ref, msg);
        return;
      } finally {
        route();
      }
    }
    if (tries >= ROUTE_TRIES) throw new Refusal(`the inbox of ${refText(ref)} is being moved; send again`);
    Bun.sleepSync(ROUTE_RETRY_MS);
  }
}
