import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/runtime/exec.ts";
import { TernRuntime } from "../src/runtime/tern/index.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { block, FakeTern, OMP } from "./fake-tern.ts";

/**
 * Synthetic extension state and process evidence for one Tern block running OMP: no real agent, terminal or ps is
 * started. The block's shell (pid 100) runs OMP (pid 101), which wrote the record; `control` changes the `ps` view.
 */
export function ompWorld(withState = true) {
  const stateDir = mkdtempSync(join(tmpdir(), "cataly-omp-"));
  const ref: SessionRef = { runtime: "tern", id: "5001" };
  const path = join(stateDir, "sessions", `${encodeURIComponent(ref.id)}.json`);
  const record = {
    paneId: ref.id,
    role: "lane",
    sessionId: "omp-session-1",
    sessionFile: "/synthetic/omp-session-1.jsonl",
    cwd: "/w",
    pid: OMP.pid,
    startedAt: "2026-11-11T00:00:05Z",
    updatedAt: "2026-11-11T00:00:05Z",
    goal: { status: "active", objective: "finish the assigned task" },
    approvalPending: false,
    agentStatus: undefined as "idle" | "working" | undefined,
  };
  mkdirSync(join(stateDir, "sessions"));
  const save = () => writeFileSync(path, JSON.stringify(record));
  if (withState) save();
  const control = {
    table: `100 1 /bin/zsh\n${OMP.pid} 100 bun /synthetic/omp --cataly-role lane\n`,
    started: "2026-11-11T00:00:00Z",
    psCode: 0,
    onPs: (_argv: readonly string[]): void => {},
  };
  const fake = new FakeTern({ [ref.id]: block() });
  const psCalls: (readonly string[])[] = [];
  const exec: Exec = async (cmd, argv, options) => {
    if (cmd !== "ps") return fake.exec(cmd, argv, options);
    psCalls.push(argv);
    control.onPs(argv);
    return { code: control.psCode, stdout: argv[0] === "-A" ? control.table : control.started, stderr: "" };
  };
  const rt = new TernRuntime(exec, { env: {}, stateDir, sleep: async () => {} });
  return { fake, rt, ref, record, save, path, stateDir, control, psCalls };
}
