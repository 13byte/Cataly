import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { backlogAdd } from "../src/backlog.ts";
import { loopTick } from "../src/loop.ts";
import { World, tref } from "./fake.ts";

/** The lead's session in every loop test world. */
export const LEAD = "1";

export function setup(opts: { lead?: boolean } = {}) {
  const w = new World();
  const d = w.deps();
  const lead = w.addTerminal(LEAD, "idle");
  if (opts.lead !== false) d.store.setRole("lead", tref(LEAD));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Do the thing.");
  const add = (id: string, o: Parameters<typeof backlogAdd>[3] = {}) =>
    backlogAdd(d, id, brief, { cwd: d.store.root, ...o });
  const tick = (o: Parameters<typeof loopTick>[1] = {}) => loopTick(d, { force: true, ...o });
  const destructive = () => w.calls.filter((c) => c.cmd === "close" || c.argv.join(" ").match(/pr merge|push/));
  return { w, d, lead, brief, add, tick, destructive };
}
