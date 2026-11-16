import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Lane, Registry } from "../src/registry.ts";

test("a public lane read remains coherent when registration disappears after an existence probe", async () => {
  const registry = new Registry(mkdtempSync(join(tmpdir(), "dori-registry-read-removal-")));
  const lane: Lane = {
    key: "qa-read-removal",
    title: "read removal race",
    thread: "local-only",
    brief: "local-only",
    done: "local-only",
    openedAt: "2026-01-01T00:00:00.000Z",
  };
  expect(await registry.create(lane)).toBe(true);
  const originalFile = Bun.file.bind(Bun);
  const files = spyOn(Bun, "file").mockImplementation((path, options) => {
    const file =
      typeof path === "number"
        ? originalFile(path, options)
        : typeof path === "string" || path instanceof URL
          ? originalFile(path, options)
          : originalFile(path, options);
    const exists = file.exists.bind(file);
    file.exists = async () => {
      const existed = await exists();
      if (String(path) === registry.path(lane.key)) await registry.discard(lane);
      return existed;
    };
    return file;
  });
  try {
    // The read may precede or follow discard, but must not reject between two filesystem observations.
    expect([null, lane]).toContainEqual(await registry.read(lane.key));
  } finally {
    files.mockRestore();
  }
});
