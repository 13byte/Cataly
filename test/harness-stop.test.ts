import { expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { up } from "../src/cli-up.ts";
import { HeadlessRuntime, headlessArgv } from "../src/runtime/headless.ts";
import { writePrivate } from "../src/runtime/headless-record.ts";
import { World } from "./fake.ts";
import { terminal } from "./fake-hc.ts";
import { captureIo } from "./inbox-setup.ts";

test("legacy stop is all-or-nothing and never mutates live terminals", async () => {
  const w = new World();
  const d = w.deps();
  const lead = { runtime: "hc", id: "t1" } as const;
  const duty = { runtime: "hc", id: "t2" } as const;
  d.store.setRole("lead", lead);
  d.store.setRole("duty", duty);
  try {
    w.hc.terminals.set("t2", terminal());
    await expect(up(d, d.store.root)).rejects.toThrow("already has registered roles");
    expect(w.calls).toEqual([]);
    await expect(main(["stop"], d)).rejects.toThrow("still present");
    expect(d.store.roles()).toEqual({ lead, duty });
    expect(w.hc.terminals.get("t2")?.state).toBe("live");

    w.hc.terminals.set("t2", terminal({ state: "finished" }));
    w.hc.knobs.getError = "unavailable";
    await expect(main(["stop"], d)).rejects.toThrow("Legacy roles left unchanged");
    expect(d.store.roles()).toEqual({ lead, duty });

    delete w.hc.knobs.getError;
    expect((await captureIo(() => main(["stop"], d))).out).toInclude("retired 2 already-gone");
    expect(d.store.roles()).toEqual({});
    expect(w.hc.terminals.get("t2")?.state).toBe("finished");
    expect(w.hc.calls.every(([op]) => op === "ls" || op === "get")).toBe(true);
  } finally {
    rmSync(d.store.root, { recursive: true, force: true });
  }
});

test("legacy stop does not infer absence from an unavailable daemon", async () => {
  const w = new World();
  w.exec = async () => ({ code: 127, stdout: "", stderr: "binary missing", spawnFailed: true });
  const d = w.deps();
  const lead = { runtime: "herdr", id: "w1:p2" } as const;
  d.store.setRole("lead", lead);
  try {
    await expect(main(["stop"], d)).rejects.toThrow("binary missing");
    expect(d.store.roles()).toEqual({ lead });
  } finally {
    rmSync(d.store.root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "partial native start is retained until exact stop evidence exists",
  async () => {
    const d = new World().deps();
    const stateDir = join(d.store.root, "state");
    const rt = new HeadlessRuntime(stateDir);
    const inventory = join(d.store.root, "harness-native.json");
    try {
      const ref = await rt.create({ name: "lead", role: "lead", cwd: d.store.root, env: {}, container: "tab" });
      const dir = join(stateDir, "headless", ref.id);
      writePrivate(inventory, { version: 1, stateDir, roles: { lead: { ref } } });
      await expect(up(d, d.store.root)).rejects.toThrow("already registered or held");
      const marker = join(dir, "started");
      writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
      await expect(main(["stop"], d)).rejects.toThrow("identity is unconfirmed");
      expect(existsSync(inventory)).toBe(true);
      expect(existsSync(join(dir, "stopped.json"))).toBe(false);

      // A broker that exits normally writes an owner-only stop receipt; stop never signals a PID from disk.
      writePrivate(join(dir, "stopped.json"), {});
      expect((await captureIo(() => main(["stop"], d))).out).toInclude("STOPPED native harness");
      expect(existsSync(inventory)).toBe(false);
    } finally {
      rmSync(d.store.root, { recursive: true, force: true });
    }
  },
);

test("harness role argv is idle and preserves trusted native option boundaries", () => {
  expect(headlessArgv(["omp", "--cataly-role", "lane", "--model", "{model}", "{prompt}"], "p/m", "lead")).toEqual([
    "omp",
    "--model",
    "p/m",
    "--cataly-role",
    "cataly",
  ]);
  for (const options of [
    ["unexpected initial turn"],
    ["--cataly-role=lane", "--cataly-role=cataly"],
    ["--mode=rpc"],
    ["--cwd=elsewhere"],
    ["--plan-yolo"],
  ])
    expect(() => headlessArgv(["omp", ...options, "{prompt}"], "p/m", "duty")).toThrow();
});
