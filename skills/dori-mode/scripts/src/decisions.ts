import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";

import {
  type Decision,
  type DecisionAsk,
  DecisionError,
  type DecisionRead,
  type Event,
  inRange,
  isTorn,
  MAX_OPTIONS,
  parseEvent,
  settled,
} from "./decisions-record.ts";
import { Worklog } from "./worklog.ts";

const asked = ({
  id,
  at,
  question,
  source,
  lane,
  thread,
  options,
  recommend,
  worklog,
  message,
}: Event & { op: "ask" }) => ({
  id,
  question,
  source,
  askedAt: at,
  ...(lane !== undefined ? { lane } : {}),
  ...(thread !== undefined ? { thread } : {}),
  options: options ?? [],
  ...(recommend !== undefined ? { recommend } : {}),
  ...(worklog !== undefined ? { worklog } : {}),
  ...(message !== undefined ? { message } : {}),
});

/**
 * The product choices the lead put to the owner and is waiting on. decisions.jsonl is the record: one O_APPEND write
 * per change, so concurrent writers never lose each other's lines, and the lead re-posts the open list from it, not
 * from memory. The first answer or withdrawal of a decision wins.
 */
export class Decisions {
  readonly path: string;

  constructor(readonly stateDir: string) {
    this.path = join(stateDir, "decisions.jsonl");
  }

  read(): DecisionRead {
    return this.fold(existsSync(this.path) ? readFileSync(this.path, "utf8") : "");
  }

  /** Open decisions posted as exactly this message; more than one means the reply cannot be bound. */
  match(message: string): Decision[] {
    return this.read().items.filter((d) => settled(d) === undefined && d.message === message);
  }

  ask(input: DecisionAsk, now: number): Decision {
    const options = (input.options ?? []).map((o) => o.trim());
    if (options.length > MAX_OPTIONS) throw new DecisionError(`at most ${MAX_OPTIONS} options`);
    if (input.worklog !== undefined && !new Worklog(this.stateDir).open().some((item) => item.id === input.worklog))
      throw new DecisionError(`no open worklog item ${input.worklog}`);
    const message = input.message?.trim();
    if (message !== undefined) this.unbound(message);
    const known = new Set(this.read().items.map((d) => d.id));
    let id = randomBytes(4).toString("hex");
    while (known.has(id)) id = randomBytes(4).toString("hex");
    const lane = input.lane?.trim();
    const thread = input.thread?.trim();
    return this.write({
      op: "ask",
      id,
      at: new Date(now).toISOString(),
      question: input.question.trim(),
      source: input.source.trim(),
      ...(lane !== undefined ? { lane } : {}),
      ...(thread !== undefined ? { thread } : {}),
      ...(options.length ? { options } : {}),
      ...(input.recommend !== undefined ? { recommend: input.recommend } : {}),
      ...(input.worklog !== undefined ? { worklog: input.worklog } : {}),
      ...(message !== undefined ? { message } : {}),
    });
  }

  posted(id: string, message: string, now: number): Decision {
    this.openDecision(id);
    this.unbound(message.trim(), id);
    return this.write({ op: "posted", id, at: new Date(now).toISOString(), message: message.trim() });
  }

  /** A bare number names an option; any other text is free text. A number outside the options is refused, never guessed. */
  answer(id: string, text: string, source: string, now: number): Decision {
    const decision = this.openDecision(id);
    const answer = text.trim();
    const count = decision.options.length;
    const option = count && /^\d+$/.test(answer) ? Number(answer) : undefined;
    if (option !== undefined && !inRange(option, count))
      throw new DecisionError(`decision ${id} has options 1 to ${count}; ${answer} is not one`);
    return this.write({
      op: "answer",
      id,
      at: new Date(now).toISOString(),
      answer,
      source: source.trim(),
      ...(option !== undefined ? { option } : {}),
    });
  }

  withdraw(id: string, reason: string, now: number): Decision {
    this.openDecision(id);
    return this.write({ op: "withdraw", id, at: new Date(now).toISOString(), reason: reason.trim() });
  }

  // One open decision per posted message, so a reply to it binds to exactly one question.
  private unbound(message: string, except?: string): void {
    const other = this.match(message).find((d) => d.id !== except);
    if (other) throw new DecisionError(`message ${message} is already bound to open decision ${other.id}`);
  }

  private openDecision(id: string): Decision {
    const decision = this.read().items.find((d) => d.id === id);
    if (!decision) throw new DecisionError(`decision not found: ${id}`);
    const state = settled(decision);
    if (state === "answered") throw new DecisionError(`decision ${id} is answered: ${decision.answer ?? ""}`);
    if (state === "withdrawn") throw new DecisionError(`decision ${id} is withdrawn: ${decision.reason ?? ""}`);
    return decision;
  }

  private fold(text: string): DecisionRead {
    const items = new Map<string, Decision>();
    const problems: string[] = [];
    const warnings: string[] = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      const where = `${this.path}:${index + 1}`;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (!isTorn(line)) problems.push(`${where}: ${error.message}`);
        continue;
      }
      try {
        const event = parseEvent(value);
        const item = items.get(event.id);
        if (event.op === "ask") {
          if (item) throw new DecisionError(`decision ${event.id} was already asked`);
          items.set(event.id, asked(event));
          continue;
        }
        if (!item) throw new DecisionError(`decision ${event.id} was never asked`);
        // Two writers can both see the decision open and append. The first answer or withdrawal wins; anything after
        // it is the same race's normal result, ignored and named.
        const state = settled(item);
        if (state !== undefined) {
          warnings.push(`${where}: decision ${event.id} was already ${state}; ${event.op} ignored`);
          continue;
        }
        if (event.op === "posted") items.set(event.id, { ...item, message: event.message });
        else if (event.op === "withdraw") items.set(event.id, { ...item, withdrawnAt: event.at, reason: event.reason });
        else {
          if (event.option !== undefined && event.option > item.options.length)
            throw new DecisionError(`decision ${event.id} has no option ${event.option}`);
          const { at, answer, source, option } = event;
          items.set(event.id, {
            ...item,
            answeredAt: at,
            answer,
            ...(option !== undefined ? { option } : {}),
            answerSource: source,
          });
        }
      } catch (error) {
        if (!(error instanceof DecisionError)) throw error;
        problems.push(`${where}: ${error.message}`);
      }
    }
    return { items: [...items.values()], problems, warnings };
  }

  private write(event: Event): Decision {
    parseEvent(event);
    mkdirSync(this.stateDir, { recursive: true });
    const fd = openSync(this.path, "a+", 0o600);
    try {
      // A writer that stopped mid-record left no newline: start on a fresh line so only the torn line is damaged.
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
      writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(event)}\n`);
    } finally {
      closeSync(fd);
    }
    const item = this.read().items.find((d) => d.id === event.id);
    if (!item) throw new DecisionError(`decision ${event.id} did not read back`);
    // A writer that raced us to resolve the decision got there first, and our record was ignored.
    const ours =
      event.op === "answer"
        ? item.answeredAt === event.at && item.answer === event.answer
        : event.op === "withdraw"
          ? item.withdrawnAt === event.at && item.reason === event.reason
          : event.op !== "posted" || item.message === event.message;
    if (!ours)
      throw new DecisionError(`decision ${event.id} was resolved by another writer first; ${event.op} ignored`);
    return item;
  }
}
