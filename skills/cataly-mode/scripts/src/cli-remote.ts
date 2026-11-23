import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { object, type Request } from "../../../../src/remote/client.ts";
import { remotePolicy, setRemotePolicy } from "../../../../src/remote/policy.ts";
import { loadConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { Registry } from "./registry.ts";
import { remoteOperation } from "./remote-worker.ts";
import { realClock, run } from "./run.ts";

const usage = `cataly remote <sessions|read|send|receipt|watch|interrupt|model|close|attach|open|wake> [SESSION]
  [--generation LIVE_GENERATION]   (OMP sessions on this machine)
  send SESSION --text TEXT [--steer] [--id REQUEST_ID] [--no-wait]
  receipt SESSION --id REQUEST_ID
  read SESSION [--limit N]
  watch SESSION [--cursor N] [--until-completion]
  model SESSION --model PROVIDER/ID
  close SESSION [--force]
  attach SESSION [--cursor N]   (prints the transcript, then follows its events)
  open [--cwd DIR] [--name NAME] [--model MODEL] [--thinking LEVEL] [--text INITIAL_PROMPT]
       [--worktree PATH [--branch BRANCH] [--base REF]] [--id REQUEST_ID]
  wake SESSION (exact saved ID)
  policy [wake on|off]`;

type Call = (request: Request) => Promise<unknown>;
const flagsFor: Readonly<Record<string, readonly string[]>> = {
  sessions: [],
  read: ["limit"],
  send: ["text", "steer", "id", "no-wait"],
  receipt: ["id"],
  watch: ["cursor", "until-completion"],
  interrupt: [],
  model: ["model"],
  close: ["force"],
  attach: ["cursor"],
  open: ["cwd", "name", "model", "thinking", "text", "worktree", "branch", "base", "id"],
  wake: [],
};

const natural = (value: string | undefined, fallback: number, max: number): number => {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number > max) throw new Error("Invalid numeric option");
  return number;
};

async function watch(call: Call, id: string, start: number, until: boolean, expected?: string): Promise<void> {
  const target = object(await call({ op: "info", session: id, ...(expected ? { generation: expected } : {}) }));
  const session = target?.["session"];
  const generation = target?.["generation"];
  if (typeof session !== "string" || typeof generation !== "string") throw new Error("Invalid session identity");
  let cursor = start;
  for (;;) {
    const page = object(await call({ op: "events", session, generation, cursor }));
    const next = page?.["cursor"];
    const events = page?.["events"];
    if (!page || typeof next !== "number" || next < cursor || !Array.isArray(events))
      throw new Error("Invalid event page");
    if (page["gap"] === true) console.log(JSON.stringify({ type: "gap", session, generation, after: cursor }));
    for (const event of events) console.log(JSON.stringify({ ...object(event), session, generation }));
    if (until && events.some((event: unknown) => object(event)?.["type"] === "completion")) return;
    cursor = next;
    await Bun.sleep(1_000);
  }
}

export async function runRemote(args: string[]): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: "boolean" },
        generation: { type: "string" },
        id: { type: "string" },
        "no-wait": { type: "boolean" },
        text: { type: "string" },
        steer: { type: "boolean" },
        limit: { type: "string" },
        cursor: { type: "string" },
        "until-completion": { type: "boolean" },
        model: { type: "string" },
        force: { type: "boolean" },
        cwd: { type: "string" },
        name: { type: "string" },
        thinking: { type: "string" },
        worktree: { type: "string" },
        branch: { type: "string" },
        base: { type: "string" },
      },
    });
    const [op, id, value] = positionals;
    if (values.help || op === undefined) {
      console.log(usage);
      return 0;
    }
    const config = await loadConfig();
    const deps: FlowDeps = { config, clock: realClock, run, registry: new Registry(config.stateDir) };
    if (op === "policy") {
      if (Object.keys(values).length || positionals.length > 3 || (id !== undefined && id !== "wake"))
        throw new Error("Use policy [wake on|off]");
      if (id !== undefined && value !== "on" && value !== "off") throw new Error("Use policy [wake on|off]");
      console.log(
        JSON.stringify(
          id === undefined ? remotePolicy(config.stateDir) : setRemotePolicy(config.stateDir, value === "on"),
        ),
      );
      return 0;
    }
    const allowed = Object.hasOwn(flagsFor, op) ? flagsFor[op] : undefined;
    if (!allowed) throw new Error("Unknown remote operation; see cataly remote --help");
    const unsupported = Object.keys(values).find(
      (flag) =>
        !(flag === "generation" && op !== "sessions" && op !== "open" && op !== "wake") && !allowed.includes(flag),
    );
    if (unsupported) throw new Error(`--${unsupported} is not supported by remote ${op}`);
    const call: Call = (request) => remoteOperation(deps, request);
    if (value !== undefined || positionals.length > 2 || (op === "open" || op === "sessions" ? id !== undefined : !id))
      throw new Error("Unexpected or missing session argument");
    const generation = values.generation;
    if (op === "watch") {
      if (!id) throw new Error("watch requires a session");
      await watch(
        call,
        id,
        natural(values.cursor, 0, Number.MAX_SAFE_INTEGER),
        values["until-completion"] ?? false,
        generation,
      );
      return 0;
    }
    if (op === "attach") {
      if (!id) throw new Error("attach requires a session");
      const result = object(await call({ op, session: id, ...(generation ? { generation } : {}) }));
      if (typeof result?.["session"] !== "string" || typeof result["generation"] !== "string")
        throw new Error("No verified transcript to attach");
      const session = result["session"];
      const exact = result["generation"];
      console.log(JSON.stringify(await call({ op: "read", session, generation: exact })));
      await watch(call, session, natural(values.cursor, 0, Number.MAX_SAFE_INTEGER), false, exact);
      return 0;
    }
    if (op === "send" && !values.text?.trim()) throw new Error("send requires non-empty --text");
    if (op === "receipt" && !values.id) throw new Error("receipt requires --id");
    if (op === "model" && !values.model) throw new Error("model requires --model");
    const { text, steer, force, model, cwd, name, thinking, worktree, branch, base } = values;
    // Unset fields stay absent from the request.
    const request = Object.fromEntries(
      Object.entries({
        op,
        session: id,
        generation,
        id: op === "send" || op === "open" ? (values.id ?? randomUUID()) : values.id,
        text,
        steer,
        force,
        model,
        cwd,
        name,
        thinking,
        worktree,
        branch,
        base,
        limit: values.limit === undefined ? undefined : natural(values.limit, 20, 40),
      }).filter(([, item]) => item !== undefined),
    ) as Request;
    let result = await call(request);
    if (op === "send" && !values["no-wait"]) {
      const accepted = object(result);
      const session = accepted?.["session"];
      const exact = accepted?.["generation"];
      const requestId = request.id;
      if (typeof session === "string" && typeof exact === "string" && requestId) {
        for (let attempt = 0; attempt < 6 && object(result)?.["status"] === "pending"; attempt++) {
          await Bun.sleep(250);
          try {
            const receipt = object(await call({ op: "receipt", session, generation: exact, id: requestId }));
            if (!receipt || receipt["status"] === "not-found") break;
            result = { ...receipt, session, generation: exact };
          } catch {
            // The sender has an ID and generation to check; never send the text again after a lost reply.
            break;
          }
        }
      }
    }
    console.log(JSON.stringify(result));
    const outcome = object(result);
    const initial = object(outcome?.["delivery"]);
    if (outcome?.["status"] === "refused" || outcome?.["status"] === "not-found") return 2;
    if (outcome?.["deliveryError"] !== undefined || outcome?.["status"] === "close-unconfirmed") return 3;
    if (initial?.["status"] === "refused" || initial?.["status"] === "unconfirmed") return 3;
    if (op === "send" && !values["no-wait"] && outcome?.["status"] === "pending") return 3;
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
