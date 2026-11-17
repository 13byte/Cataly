/** dori decision: the owner's pending product choices, kept in a record so the lead never re-asks from memory. */
import { type Command, die } from "./cli-context.ts";
import { Decisions } from "./decisions.ts";
import { type Decision, DecisionError, type DecisionRead, settled } from "./decisions-record.ts";
import { decisionText } from "./decisions-render.ts";
import { realClock } from "./run.ts";
import { Worklog } from "./worklog.ts";

/** Decision errors are the user's input refused: one line, never a stack. */
export const decisionErrors = [DecisionError] as const;

const show = (decision: Decision) => console.log(JSON.stringify(decision));

/** Every reading command names the ledger's damage and race warnings on stderr, then works from the rest. */
const warned = (read: DecisionRead): DecisionRead => {
  for (const problem of [...read.problems, ...read.warnings]) console.error(`DECISION_WARNING ${problem}`);
  return read;
};

// The answer is already recorded; a note that cannot be written is named and never undoes it.
const noteWorklog = (stateDir: string, decision: Decision, now: number): void => {
  const id = decision.worklog;
  if (id === undefined) return;
  try {
    const worklog = new Worklog(stateDir);
    if (worklog.open().some((item) => item.id === id))
      worklog.note(id, `decision ${decision.id} answered: ${decision.answer ?? ""}`, now);
  } catch (e) {
    console.error(`DECISION_WARNING worklog ${id} note not written: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const decision: Command = async ({ key, positionals, values, opt, need, strings, deps, config }) => {
  const ledger = new Decisions(config.stateDir);
  const id = () => positionals[1] ?? die(`decision ${key} needs a decision id`);
  const now = realClock.now();
  switch (key) {
    case "ask": {
      const question = positionals.slice(1).join(" ").trim() || die("decision ask needs a question");
      const laneKey = opt("lane");
      const lane =
        laneKey === undefined
          ? undefined
          : ((await deps.registry.read(laneKey)) ?? die(`no registered lane "${laneKey}"`));
      // `launch` records a lane without a thread as "none".
      const laneThread = lane?.thread && lane.thread !== "none" ? lane.thread : undefined;
      const given = opt("thread");
      const thread = given === "none" ? undefined : given || laneThread;
      // parseArgs turns a trailing `--option` with no text into `true`; dropping it would lose an option unseen.
      const options = values["option"];
      if (Array.isArray(options) && options.some((o) => typeof o !== "string")) die("--option needs the option text");
      const recommend = opt("recommend");
      if (recommend !== undefined && !/^\d+$/.test(recommend)) die("--recommend must be an option number");
      const worklog = opt("worklog");
      const message = opt("message");
      show(
        ledger.ask(
          {
            question,
            source: need("source"),
            ...(lane !== undefined ? { lane: lane.key } : {}),
            ...(thread !== undefined ? { thread } : {}),
            options: strings("option"),
            ...(recommend !== undefined ? { recommend: Number(recommend) } : {}),
            ...(worklog !== undefined ? { worklog } : {}),
            ...(message !== undefined ? { message } : {}),
          },
          now,
        ),
      );
      return;
    }
    case "posted":
      show(ledger.posted(id(), need("message"), now));
      return;
    case "answer": {
      const answered = ledger.answer(
        id(),
        positionals.slice(2).join(" ").trim() || die("decision answer needs the answer"),
        need("source"),
        now,
      );
      noteWorklog(config.stateDir, answered, now);
      show(answered);
      return;
    }
    case "withdraw": {
      const reasons = strings("reason");
      const [reason] = reasons;
      if (reasons.length !== 1 || reason === undefined) die("decision withdraw needs exactly one --reason");
      show(ledger.withdraw(id(), reason ?? "", now));
      return;
    }
    case "match": {
      const message = positionals[1] ?? die("decision match needs a message ref");
      // The fold lets one open decision hold a message, so the first open one found is the only one.
      const found = warned(ledger.read()).items.find((d) => settled(d) === undefined && d.message === message);
      if (found === undefined) process.exit(1);
      show(found);
      return;
    }
    case "list": {
      const read = warned(ledger.read());
      const open = read.items.filter((d) => settled(d) === undefined);
      console.log(JSON.stringify(values["open"] ? open : read.items, null, 2));
      return;
    }
    case "digest":
      for (const d of warned(ledger.read()).items) if (settled(d) === undefined) console.log(decisionText(d, now));
      return;
    default:
      die("decision needs ask, posted, answer, withdraw, match, list or digest");
  }
};

export const decisionCommands: Readonly<Record<string, Command>> = { decision };
