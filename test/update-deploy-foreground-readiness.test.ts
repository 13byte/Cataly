import { expect, test } from "bun:test";
import { silentForegroundActor } from "./update-deploy-foreground-readiness.ts";

const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

posix("a silent foreground actor cannot leave readiness pending", async () => {
  const actor = silentForegroundActor();
  try {
    await actor.monitorPid();
    await expect(actor.waitForReady(100)).rejects.toThrow("actor ready line timed out after 100ms");
  } finally {
    await actor.dispose();
  }
});
