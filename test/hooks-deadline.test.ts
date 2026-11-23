import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { hooksSettled } from "../src/hooks.ts";
import { report, startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";

const config = (d: Deps, value: unknown) => writeFileSync(join(d.store.root, "config.json"), JSON.stringify(value));

describe("hooks never block a command", () => {
  test("hooksSettled returns at its deadline while a hook still runs, printing one timed-out line", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "lane-k", brief, { group: "w1" });
    let release: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.hang = hang;
    config(d, { hooks: { onReport: ["slow-hook", "{key}"] } });
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await report(d, "lane-k", "still going");
      const started = Date.now();
      await hooksSettled(50);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      process.stderr.write = original;
      release?.();
    }
    expect(lines.filter((l) => l.includes("hook onReport failed (timed out after 50 ms)"))).toHaveLength(1);
  });

  test("a hook still running at the deadline is killed before its timed-out line, and its exit adds no second line", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "lane-k", brief, { group: "w1" });
    w.hang = new Promise<void>(() => {});
    const events: string[] = [];
    w.onHookKill = () => events.push("kill");
    config(d, { hooks: { onReport: ["slow-hook", "{key}"] } });
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      events.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await report(d, "lane-k", "still going");
      await hooksSettled(50);
      // The killed hook settles now; waiting for it again must not print its exit 143.
      await hooksSettled(1000);
    } finally {
      process.stderr.write = original;
    }
    expect(events).toEqual(["kill", "cataly: hook onReport failed (timed out after 50 ms)\n"]);
  });
});
