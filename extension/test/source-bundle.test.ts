import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { requiredSourceRequest } from "../../test/fixtures/omp-native-host/required-source.ts";
import { useConfig } from "./fake-pi.ts";

for (const boundary of ["session", "provider"] as const) {
  test(`missing required overlays block real ${boundary} transport only for role sessions`, async () => {
    const keys = ["HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_OMP_ULW_PATH", "HERDR_PANE_ID", "HC_TERMINAL_ID"];
    const before = keys.map((key) => process.env[key]);
    const home = dirname(useConfig(""));
    process.env["HOME"] = home;
    process.env["DORI_OMP_ULW_PATH"] = join(home, ".cache/omp-dori", `omp-ulw-${"0".repeat(64)}`, "index.ts");
    delete process.env["HERDR_PANE_ID"];
    delete process.env["HC_TERMINAL_ID"];
    try {
      for (const role of ["lane", "dori", undefined] as const) {
        const cwd = join(home, role ?? "ordinary");
        mkdirSync(cwd);
        const result = await requiredSourceRequest(join(import.meta.dir, "../index.ts"), cwd, role, boundary);
        expect(result.errors.filter((error) => error.event === "session_start")).toEqual([]);
        expect(result.requests).toBe(role ? 0 : 1);
      }
    } finally {
      keys.forEach((key, index) => {
        if (before[index] === undefined) delete process.env[key];
        else process.env[key] = before[index];
      });
      rmSync(home, { recursive: true, force: true });
    }
  });
}
