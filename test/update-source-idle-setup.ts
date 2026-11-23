import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { captureRuntime } from "../src/update/deployment-harness.ts";
import { headlessLead } from "./update-headless-lead-setup.ts";
import { sourceFixture } from "./update-source-setup.ts";

type ReceiverMessage = "received" | "unavailable" | "healthy" | "stale" | "future" | "freeze" | "stop-receiver";

/** A real native lead whose own process starts the activity receiver, so the receiver is the lead's descendant. */
export async function idleFixture() {
  const f = sourceFixture();
  const activity = f.config.activityFiles[0]!;
  const control = join(f.root, "receiver-control");
  const receiver = join(f.root, "receiver.ts");
  writeFileSync(control, "");
  // The lead's stdio carries the native protocol, so the test drives the receiver through a polled control file.
  writeFileSync(
    receiver,
    `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { inboundActivity } from ${JSON.stringify(resolve(import.meta.dir, "../src/update/source-activity.ts"))};
const control = ${JSON.stringify(control)};
const parent = process.ppid;
let clock = Date.now() - 1_900_000;
const writer = inboundActivity(process.argv[2], "discord", () => clock);
writer.healthy();
let available = true, automatic = true, handled = 0;
clock = Date.now(); writer.healthy();
const stop = () => { clearInterval(timer); clearInterval(poll); writer.close(); process.exit(0); };
const poll = setInterval(() => {
  if (process.ppid !== parent) stop();
  const lines = readFileSync(control, "utf8").split("\\n").filter(Boolean);
  for (const message of lines.slice(handled)) {
    handled++;
    clock = Date.now();
    if (message === "received") writer.received();
    else if (message === "freeze") automatic = false;
    else if (message === "unavailable") { available = false; writer.unavailable(); }
    else if (message === "healthy") { available = true; automatic = true; writer.healthy(); }
    else if (message === "stale" || message === "future") {
      automatic = false; clock += message === "stale" ? -${f.config.activityMaxAgeMs + 10_000} : 100_000; writer.healthy();
    }
    if (message === "stop-receiver") { writeFileSync(control + ".ack", String(handled)); stop(); }
    writeFileSync(control + ".ack", String(handled));
  }
}, 20);
const timer = setInterval(() => { if (automatic && available) { clock = Date.now(); writer.healthy(); } }, 1000);
process.on("SIGTERM", stop);
`,
  );
  const deployment = f.config.deployment;
  const lead = await headlessLead(
    deployment,
    join(f.root, "lead"),
    `Bun.spawn([process.execPath, ${JSON.stringify(receiver)}, ${JSON.stringify(activity)}], { stdio: ["ignore", "ignore", "inherit"] }).unref();
while (!(await Bun.file(${JSON.stringify(activity)}).exists())) await Bun.sleep(10);`,
  );
  const runtime = await captureRuntime(deployment);
  const manifest = {
    version: 1,
    sessionId: runtime.sessionId,
    monitors: [{ name: "discord", argv: [process.execPath, receiver, activity], filter: ".*", cwd: f.root }],
    intake: { monitor: "discord", path: `${activity}.heartbeat`, maxAgeMs: 90_000 },
  };
  const desired = join(deployment.stateDir, "monitors", `${encodeURIComponent(runtime.sessionId)}.json`);
  saveDeploymentJson(desired, manifest);
  let sent = 0;
  return {
    ...f,
    activity,
    lead,
    runtime,
    desired,
    manifest,
    send: async (message: ReceiverMessage) => {
      sent++;
      writeFileSync(control, `${message}\n`, { flag: "a" });
      const deadline = Date.now() + 5_000;
      const ack = `${control}.ack`;
      while (!existsSync(ack) || Number(readFileSync(ack, "utf8")) < sent) {
        if (Date.now() >= deadline) throw new Error(`receiver did not acknowledge ${message}`);
        await Bun.sleep(10);
      }
    },
    close: () => lead.close(),
  };
}
