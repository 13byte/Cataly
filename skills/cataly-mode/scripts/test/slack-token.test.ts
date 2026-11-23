import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { launchLane } from "../src/launch.ts";
import { laneTokenEnv, OUTSIDE_HOME_FLAG, RESOLVED_HOME, RESOLVED_MARK, TokenFileError } from "../src/slack-token.ts";
import { depsFor, fakeClock, newWorld, sid, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const KEYS = ["CATALY_CONFIG", "CATALY_SLACK_TOKEN", "CATALY_SLACK_TOKEN_FILE"] as const;
let state: ReturnType<typeof withState>;
let world: World;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  state = withState();
  world = newWorld();
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  state.done();
});

// The lane gets the real path (links resolved, e.g. macOS /var -> /private/var); every path here is under state.dir.
// realpathSync.native, not the JS one: on Windows only the OS resolves a short (RUNNER~1) temp name.
const real = (p: string): string => join(realpathSync.native(state.dir), relative(state.dir, p));

const tokenFile = (dir: string, text: string, mode: number): string => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "slack-token");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
};

// The env the native lane started with, and every `KEY=value` its session was reserved with.
type Launched = { readonly env: Readonly<Record<string, string | undefined>>; readonly reserved: string[] };
const pairs = (env: Launched["env"]): string[] => Object.entries(env).map(([k, v]) => `${k}=${v}`);
const launchEnv = async (home: string, key: string, config = join(home, "config.json")): Promise<Launched> => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  process.env["CATALY_CONFIG"] = config;
  world = newWorld();
  const reserved: string[] = [];
  world.onCreate = (spec) => {
    reserved.push(...pairs(spec.env));
  };
  const deps = { ...depsFor(world, fakeClock(T0), join(home, "state"), { defaultCwd: state.dir }), env: process.env };
  await launchLane(deps, { key, title: "t", brief, done: "closed acme/app#3" });
  return { env: world.sessions[sid(1)]?.env ?? {}, reserved };
};

test("the env a lane is reserved and started with never holds the token value, only the token file's path (#200)", async () => {
  // Given a launcher with a token in its env and this home's owner-only token file next to its config.
  const home = join(state.dir, "home");
  const file = tokenFile(home, "xoxb-file-secret\n", 0o600);
  process.env["CATALY_SLACK_TOKEN"] = "xoxb-launcher-secret";
  delete process.env["CATALY_SLACK_TOKEN_FILE"];
  // When the lane is reserved and started on the native supervisor.
  const { env, reserved } = await launchEnv(home, "token-lane");
  // Then no runtime call, reservation or start env holds a token, and the lane gets the path with the token blanked.
  expect([...world.calls.flat(), ...reserved, ...pairs(env)].filter((arg) => arg.includes("xoxb-"))).toEqual([]);
  expect(reserved).toContain(`CATALY_SLACK_TOKEN_FILE=${real(file)}`);
  expect(env["CATALY_SLACK_TOKEN_FILE"]).toBe(real(file));
  expect(env["CATALY_SLACK_TOKEN"]).toBe("");
});

test("with no token file the lane env is unchanged, as in a single-home setup", async () => {
  process.env["CATALY_SLACK_TOKEN"] = "xoxb-launcher-secret";
  delete process.env["CATALY_SLACK_TOKEN_FILE"];
  const { env, reserved } = await launchEnv(join(state.dir, "plain-home"), "plain-lane");
  const passed = [...world.calls.flat(), ...reserved, ...pairs(env)];
  expect(passed.filter((arg) => arg.includes("CATALY_SLACK_TOKEN") || arg.includes("xoxb-"))).toEqual([]);
});

test("a relative token-file path is passed absolute, since the lane runs in another directory", async () => {
  const home = join(state.dir, "rel-home");
  const file = tokenFile(home, "xoxb-rel\n", 0o600);
  process.env["CATALY_SLACK_TOKEN_FILE"] = relative(process.cwd(), file);
  const { env } = await launchEnv(home, "rel-lane");
  expect(env["CATALY_SLACK_TOKEN_FILE"]).toBe(real(file));
});

test("the home's own slack-token is passed even when missing, so the lane never falls back to the core's token", async () => {
  const absent = join(state.dir, "named-home", "slack-token");
  process.env["CATALY_SLACK_TOKEN_FILE"] = absent;
  const { env } = await launchEnv(join(state.dir, "named-home"), "named-lane");
  expect(env["CATALY_SLACK_TOKEN_FILE"]).toBe(real(absent));
  expect(env["CATALY_SLACK_TOKEN"]).toBe("");
});

test("any other named token file that does not exist yet is refused: a link later put there is what the lane would follow", () => {
  const home = join(state.dir, "absent-home");
  mkdirSync(home, { recursive: true });
  const other = join(home, "named", "slack-token");
  expect(() => laneTokenEnv({ CATALY_SLACK_TOKEN_FILE: other }, join(home, "config.json"))).toThrow(/does not exist/);
});

test("an inherited CATALY_SLACK_TOKEN_FILE outside this home is refused unless the flag says it is meant", () => {
  const home = join(state.dir, "own-home");
  const config = join(home, "config.json");
  tokenFile(home, "xoxb-own\n", 0o600);
  const other = tokenFile(join(state.dir, "other-home"), "xoxb-other\n", 0o600);
  expect(() => laneTokenEnv({ CATALY_SLACK_TOKEN_FILE: other }, config)).toThrow(TokenFileError);
  expect(() => laneTokenEnv({ CATALY_SLACK_TOKEN_FILE: other }, config)).toThrow(/is outside this home/);
  // Allowed by the flag, and the flag is passed empty so the lane does not carry the permission onward.
  expect(laneTokenEnv({ CATALY_SLACK_TOKEN_FILE: other, [OUTSIDE_HOME_FLAG]: "1" }, config)).toEqual({
    CATALY_SLACK_TOKEN_FILE: real(other),
    [RESOLVED_MARK]: real(other),
    [RESOLVED_HOME]: real(home),
    CATALY_SLACK_TOKEN: "",
    [OUTSIDE_HOME_FLAG]: "",
  });
  // Unset, the home's own file is used; a file inside the home is passed as named.
  const ok = (file: string) => ({
    CATALY_SLACK_TOKEN_FILE: real(file),
    [RESOLVED_MARK]: real(file),
    [RESOLVED_HOME]: real(home),
    CATALY_SLACK_TOKEN: "",
    [OUTSIDE_HOME_FLAG]: "",
  });
  expect(laneTokenEnv({}, config)).toEqual(ok(join(home, "slack-token")));
  const nested = tokenFile(join(home, "keys"), "xoxb-nested\n", 0o600);
  expect(laneTokenEnv({ CATALY_SLACK_TOKEN_FILE: nested }, config)).toEqual(ok(nested));
  // A file whose name starts with ".." is still inside the home.
  const dotted = join(home, "..slack-token");
  writeFileSync(dotted, "xoxb-dotted\n");
  expect(laneTokenEnv({ CATALY_SLACK_TOKEN_FILE: dotted }, config)).toEqual(ok(dotted));
  // A link inside the home to another home's file is outside: links are resolved before the check.
  const link = join(home, "linked-token");
  symlinkSync(other, link);
  expect(() => laneTokenEnv({ CATALY_SLACK_TOKEN_FILE: link }, config)).toThrow(/is outside this home/);
});

test("the home's own slack-token gets the same link check, and an inherited allow flag never reaches a lane", () => {
  const other = tokenFile(join(state.dir, "far-home"), "xoxb-far\n", 0o600);
  const linked = join(state.dir, "linked-home");
  mkdirSync(linked, { recursive: true });
  symlinkSync(other, join(linked, "slack-token"));
  expect(() => laneTokenEnv({}, join(linked, "config.json"))).toThrow(/links outside this home/);
  // With no token file at all, nothing is added except emptying an inherited allow flag.
  const bare = join(state.dir, "bare-home", "config.json");
  expect(laneTokenEnv({}, bare)).toEqual({});
  expect(laneTokenEnv({ [OUTSIDE_HOME_FLAG]: "1" }, bare)).toEqual({ [OUTSIDE_HOME_FLAG]: "" });
  // The lane gets the resolved path: a link inside the home that is later swapped to another home's file is not used.
  const homeL = join(state.dir, "relink-home");
  const target = tokenFile(join(homeL, "keys"), "xoxb-own\n", 0o600);
  symlinkSync(target, join(homeL, "slack-token"));
  const passed = laneTokenEnv({}, join(homeL, "config.json"))["CATALY_SLACK_TOKEN_FILE"];
  expect(passed).toBe(realpathSync.native(target));
  const named = laneTokenEnv({ CATALY_SLACK_TOKEN_FILE: join(homeL, "slack-token") }, join(homeL, "config.json"));
  expect(named["CATALY_SLACK_TOKEN_FILE"]).toBe(realpathSync.native(target));
  // The path is resolved once: the string checked is the string passed, so no swap between two resolutions reaches the lane.
  const spy = spyOn(fs.realpathSync, "native");
  try {
    laneTokenEnv({ CATALY_SLACK_TOKEN_FILE: join(homeL, "slack-token") }, join(homeL, "config.json"));
    expect(spy.mock.calls.filter(([p]) => String(p).endsWith(join("relink-home", "slack-token"))).length).toBe(1);
  } finally {
    spy.mockRestore();
  }
  // A named link whose target does not exist yet is refused: the lane would follow it wherever it later points.
  const dangling = join(homeL, "dl");
  symlinkSync(join(state.dir, "not-yet", "slack-token"), dangling);
  expect(() => laneTokenEnv({ CATALY_SLACK_TOKEN_FILE: dangling }, join(homeL, "config.json"))).toThrow(
    /is a link whose target does not exist/,
  );
});

test("a launch with a token file outside this home is refused before any session is created", async () => {
  const home = join(state.dir, "launch-home");
  const other = tokenFile(join(state.dir, "launch-other"), "xoxb-other\n", 0o600);
  delete process.env["CATALY_SLACK_TOKEN"];
  process.env["CATALY_SLACK_TOKEN_FILE"] = other;
  delete process.env[OUTSIDE_HOME_FLAG];
  await expect(launchEnv(home, "outside-lane")).rejects.toThrow(
    /^token file refused: CATALY_SLACK_TOKEN_FILE .* is outside this home/,
  );
  expect(world.calls.filter((c) => c[0] === "headless")).toEqual([]);
});

test("a relative CATALY_CONFIG is passed to the lane absolute, so the lane finds the same home and its token-file mark holds", async () => {
  const home = join(state.dir, "rel-config-home");
  const file = tokenFile(home, "xoxb-rel\n", 0o600);
  delete process.env["CATALY_SLACK_TOKEN"];
  delete process.env["CATALY_SLACK_TOKEN_FILE"];
  const config = relative(process.cwd(), join(home, "config.json"));
  const { env } = await launchEnv(home, "relconf-lane", config);
  // A path that has no relative form (another drive on Windows) is already absolute and reaches the lane as it is.
  const passed = isAbsolute(config) ? config : `${process.cwd()}${sep}${config}`;
  expect(env["CATALY_CONFIG"]).toBe(passed);
  expect(env["CATALY_SLACK_TOKEN_FILE"]).toBe(real(file));
});

test("a CATALY_CONFIG whose home moves when normalized (empty, '.', '..') is refused instead of moving the home up", async () => {
  delete process.env["CATALY_SLACK_TOKEN"];
  delete process.env["CATALY_SLACK_TOKEN_FILE"];
  const home = join(state.dir, "bad-config-home");
  for (const raw of ["", ".", ".."]) {
    await expect(launchEnv(home, `bad-${raw.length}`, raw)).rejects.toThrow(/does not name a config file/);
  }
});

test("an absolute CATALY_CONFIG reaches the lane unchanged, so a link in it resolves for the lane as it did for the launcher", async () => {
  delete process.env["CATALY_SLACK_TOKEN"];
  delete process.env["CATALY_SLACK_TOKEN_FILE"];
  const home = join(state.dir, "abs-home");
  mkdirSync(home, { recursive: true });
  const raw = `${home}/sub/../config.json`;
  const { env } = await launchEnv(home, "abs-lane", raw);
  expect(env["CATALY_CONFIG"]).toBe(raw);
});

test("a relative CATALY_CONFIG with '..' keeps it, so the OS follows a link in it for the lane as it did for the launcher", async () => {
  delete process.env["CATALY_SLACK_TOKEN"];
  delete process.env["CATALY_SLACK_TOKEN_FILE"];
  const home = join(state.dir, "dotdot-home");
  mkdirSync(join(home, "sub"), { recursive: true });
  const raw = `${relative(process.cwd(), join(home, "sub"))}${sep}..${sep}config.json`;
  const { env } = await launchEnv(home, "dotdot-lane", raw);
  // Not collapsed on paper: the '..' is still there for the OS to resolve. A cross-drive path is already absolute.
  const passed = isAbsolute(raw) ? raw : `${process.cwd()}${sep}${raw}`;
  expect(env["CATALY_CONFIG"]).toBe(passed);
});
