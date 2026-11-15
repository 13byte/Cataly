import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { load, useConfig } from "./fake-pi.ts";

test("a missing managed default blocks role requests instead of running without its required overlay", async () => {
  const keys = ["HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_OMP_ULW_PATH"];
  const before = keys.map((key) => process.env[key]);
  const state = useConfig("");
  const home = dirname(state);
  process.env["HOME"] = home;
  process.env["DORI_OMP_ULW_PATH"] = join(home, ".cache/omp-dori", `omp-ulw-${"0".repeat(64)}`, "index.ts");
  try {
    const role = await load({ session: { id: "required-source-role", entries: [] }, flags: { "dori-role": "lane" } });
    await role.emit("session_start");
    await expect(role.emit("before_agent_start", { systemPrompt: ["base"] })).rejects.toThrow();
    await expect(role.emit("before_provider_request", { systemPrompt: ["base"] })).rejects.toThrow();
    const ordinary = await load({ session: { id: "ordinary-source-role", entries: [] } });
    await ordinary.emit("session_start");
    await expect(ordinary.emit("before_provider_request", { systemPrompt: ["base"] })).resolves.toBeDefined();
  } finally {
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    });
    rmSync(home, { recursive: true, force: true });
  }
});
