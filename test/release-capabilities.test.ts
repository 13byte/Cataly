import { expect, test } from "bun:test";
import { headlessReleaseProfiles } from "../src/release/capabilities.ts";
import type { ReleaseManifest } from "../src/release/types.ts";
import { digest } from "../src/update/source.ts";
import { releaseFixture } from "./release-producer-setup.ts";

const linux = { platform: "linux", arch: "x64", runtime: "headless" } as const;
const darwin = { platform: "darwin", arch: "arm64", runtime: "headless" } as const;

function bound(bytes: Uint8Array, omp = "18.20.0"): ReleaseManifest {
  const fixture = releaseFixture();
  const files = [
    ...fixture.source.files,
    { path: "release-headless.json", sha256: digest(bytes), executable: false },
  ].sort((a, b) => a.path.localeCompare(b.path));
  return {
    ...fixture,
    source: { ...fixture.source, files, hash: digest(JSON.stringify({ files, ulwPresent: false })) },
    requirements: { ...fixture.requirements, omp } as ReleaseManifest["requirements"],
  };
}

test("a release without the headless marker is historical and has no profiles", () => {
  const manifest = releaseFixture();
  expect(headlessReleaseProfiles(manifest)).toEqual([]);
  expect(() => headlessReleaseProfiles(manifest, Buffer.from("{}"))).toThrow("Unexpected");
});

test("source-bound metadata selects exact headless profiles", () => {
  const bytes = Buffer.from(JSON.stringify({ version: 1, profiles: [darwin, linux] }));
  expect(headlessReleaseProfiles(bound(bytes), bytes)).toEqual([darwin, linux]);
  expect(() => headlessReleaseProfiles(bound(bytes))).toThrow("SHA256");
  expect(() => headlessReleaseProfiles(bound(bytes), Buffer.from("{}"))).toThrow("SHA256");
  expect(() => headlessReleaseProfiles(bound(bytes, "18.18.8"), bytes)).toThrow("bound native OMP");
});

test.each([
  { value: undefined },
  { value: null },
  { value: {} },
  { value: { version: 2, profiles: [linux] } },
  { value: { version: 1, profiles: [] } },
  { value: { version: 1, profiles: [null] } },
  { value: { version: 1, profiles: [{ platform: "linux", arch: "x64" }] } },
  { value: { version: 1, profiles: [{ ...linux, extra: true }] } },
  { value: { version: 1, profiles: [{ ...linux, arch: "arm64" }] } },
  { value: { version: 1, profiles: [{ ...linux, runtime: "herdr" }] } },
  { value: { version: 1, profiles: [{ ...darwin, runtime: "hc" }] } },
  { value: { version: 1, profiles: [linux, linux] } },
  { value: { version: 1, profiles: [linux], extra: true } },
])("rejects malformed, terminal or duplicate source metadata: $value", ({ value }) => {
  const bytes = Buffer.from(JSON.stringify(value) ?? "undefined");
  expect(() => headlessReleaseProfiles(bound(bytes), bytes)).toThrow();
});
