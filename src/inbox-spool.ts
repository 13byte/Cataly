import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendQueue, forwardOf, inboxFile, mergeSpool, spoolDir } from "./inbox-files.ts";
import { takeInboxLock } from "./inbox-lock.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

// A message queued while another process holds the inbox lock is written to a file of its own in `<inbox>.spool/`, and
// the holder of the lock moves it into the queue. A holder rewrites the queue from what it read, so an append beside it
// would be lost; one file per message means nothing it moves can still be written to.

let spoolSeq = 0;

/** Spools `msg` for the queue at `path` in a file of its own, written aside and renamed in whole. */
function spoolMessage(path: string, msg: QueuedMessage): void {
  mkdirSync(spoolDir(path), { recursive: true });
  const name = `${String(msg.at).padStart(15, "0")}-${String(spoolSeq++).padStart(9, "0")}-${randomUUID()}`;
  const file = join(spoolDir(path), `${name}.jsonl`);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(msg)}\n`);
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

/** Appends `msg` to ref's queue under its lock; while another process holds the lock, spools it for that holder. */
export function queueMessage(root: string, ref: SessionRef, msg: QueuedMessage): void {
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
