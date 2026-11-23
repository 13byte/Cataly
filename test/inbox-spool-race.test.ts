import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { hostname } from "node:os";
import type { Deps } from "../src/harness.ts";
import { send } from "../src/inbox.ts";
import { Refusal } from "../src/refusal.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { href } from "./fake.ts";
import { PANE, setup } from "./inbox-setup.ts";

const OLD = href(PANE);

afterEach(() => mock.restore());

const REAL = {
  appendFileSync: fs.appendFileSync,
  rmSync: fs.rmSync,
};

/**
 * The first call of fs[name] whose path matches `hit` runs `first` before it goes on: `first` throws (the caller
 * stopped there). Returns whether it ran.
 */
function onceAt(name: keyof typeof REAL, hit: (p: string) => boolean, first: () => void): () => boolean {
  const real = REAL[name] as (...a: unknown[]) => unknown;
  let armed = true;
  spyOn(fs, name).mockImplementation(((...a: unknown[]) => {
    if (armed && hit(String(a[0]))) {
      armed = false;
      first();
    }
    return real(...a);
  }) as never);
  return () => !armed;
}

/** Another live process holding the route of ref's inbox (the lock a send holds from finding its inbox to writing). */
function holdRoute(d: Deps, ref: SessionRef): () => void {
  const path = `${d.store.inboxPath(ref)}.route`;
  fs.writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), at: d.now() }));
  return () => fs.rmSync(path);
}

const texts = (d: Deps, ref: SessionRef) => d.store.queued(ref).map((m) => m.text);

test("a send whose route stays held is refused and queues nothing", async () => {
  const s = setup();
  holdRoute(s.d, OLD);
  spyOn(Bun, "sleep").mockImplementation(async () => {});
  await expect(send(s.d, `headless:${PANE}`, "refused", "cli")).rejects.toBeInstanceOf(Refusal);
  expect(s.d.store.inboxPanes()).toEqual([]);
  expect(s.pane.received).toEqual([]);
});

describe("a spooled message moved by a holder that stopped part way is queued exactly once", () => {
  /**
   * "same" queued, then "same" again at the same millisecond while another process held the lock: two messages. The
   * holder never let go (it died holding the lock, now judged stale), so the second still waits in the spool.
   */
  async function twoEqual() {
    const s = setup();
    const msg = { at: s.d.now(), from: "cli", text: "same" };
    await s.d.store.enqueue(OLD, msg, false);
    const lock = `${s.d.store.inboxPath(OLD)}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: s.d.now() }));
    await s.d.store.enqueue(OLD, msg, false);
    fs.rmSync(lock);
    return s;
  }

  test("renamed aside, stopped before its append, beside an equal queued message: it is still added", async () => {
    const s = await twoEqual();
    onceAt(
      "appendFileSync",
      (p) => p === s.d.store.inboxPath(OLD),
      () => {
        throw new Error("stopped before the append");
      },
    );
    expect(() => s.d.store.lockInbox(OLD, s.d.now())).toThrow("stopped before the append");
    mock.restore();
    s.d.store.lockInbox(OLD, s.d.now())!();
    expect(texts(s.d, OLD)).toEqual(["same", "same"]);
    expect(fs.readdirSync(`${s.d.store.inboxPath(OLD)}.spool`)).toEqual([]);
  });

  test("appended, stopped before removing its file, beside an equal queued message: it is not added again", async () => {
    const s = await twoEqual();
    onceAt(
      "rmSync",
      (p) => p.endsWith(".moving"),
      () => {
        throw new Error("stopped before the remove");
      },
    );
    expect(() => s.d.store.lockInbox(OLD, s.d.now())).toThrow("stopped before the remove");
    mock.restore();
    s.d.store.lockInbox(OLD, s.d.now())!();
    expect(texts(s.d, OLD)).toEqual(["same", "same"]);
    expect(fs.readdirSync(`${s.d.store.inboxPath(OLD)}.spool`)).toEqual([]);
  });
});
