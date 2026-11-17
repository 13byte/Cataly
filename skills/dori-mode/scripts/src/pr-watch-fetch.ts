/** One read of a tracked PR through `gh api`: state, head, feedback, commits (when asked) and failing checks. */
import type { PrRef } from "./pr-watch.ts";

type Api = (endpoint: string) => Promise<unknown>;

export type Feedback = {
  readonly key: string;
  readonly kind: string;
  readonly by: string;
  readonly url: string;
  readonly body: string;
};
export type PrCommitAuthors = { readonly sha: string; readonly people: readonly string[] };
export type FailedCheck = {
  readonly key: string;
  readonly name: string;
  readonly conclusion: string;
  readonly url: string;
};
export type PrSnapshot = {
  readonly state: "open" | "merged" | "closed";
  readonly head: string;
  readonly url: string;
  readonly mergeSha?: string;
  readonly feedback: readonly Feedback[];
  /** Read only when the head moved (or on the first read); undefined means "unchanged, not read". */
  readonly commits?: readonly PrCommitAuthors[];
  readonly failed: readonly FailedCheck[];
};

const SHA = /^[a-f0-9]{40}$/i;
const FAILED_CHECK: Readonly<Record<string, true>> = {
  failure: true,
  timed_out: true,
  cancelled: true,
  action_required: true,
  startup_failure: true,
};
const FAILED_STATUS: Readonly<Record<string, true>> = { failure: true, error: true };
// GitHub records commits made in its web UI with this committer; the author is the person.
const WEB_COMMITTER = "web-flow";

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`incomplete ${what}`);
  return value as Record<string, unknown>;
};
const loginOf = (user: unknown): string | undefined => {
  const login = (user as { login?: unknown } | null)?.login;
  return typeof login === "string" && login ? login : undefined;
};
const idOf = (row: Record<string, unknown>, what: string): number => {
  if (!Number.isSafeInteger(row["id"])) throw new Error(`incomplete ${what}`);
  return row["id"] as number;
};
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Every page of a list endpoint, 100 rows at a time; more than 3000 rows is refused rather than read partly. */
const pages = async (api: Api, endpoint: string, rows: (body: unknown) => unknown[]): Promise<unknown[]> => {
  const all: unknown[] = [];
  for (let page = 1; ; page++) {
    const got = rows(await api(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
    all.push(...got);
    if (got.length < 100) return all;
    if (page >= 30) throw new Error(`${endpoint}: more than 3000 rows`);
  }
};
const list = (what: string) => (body: unknown) => {
  if (!Array.isArray(body)) throw new Error(`incomplete ${what}`);
  return body;
};

const comments = async (api: Api, endpoint: string, kind: string, prefix: string): Promise<Feedback[]> =>
  (await pages(api, endpoint, list(kind))).map((value) => {
    const row = record(value, kind);
    return {
      key: `${prefix}:${idOf(row, kind)}`,
      kind,
      by: loginOf(row["user"]) ?? "ghost",
      url: text(row["html_url"]),
      body: text(row["body"]),
    };
  });

const reviews = async (api: Api, root: string): Promise<Feedback[]> =>
  (await pages(api, `${root}/reviews`, list("review"))).flatMap((value) => {
    const row = record(value, "review");
    const state = text(row["state"]);
    // A pending review is the reviewer's draft; a bare "commented" review carries its words in its review comments.
    if (state === "PENDING" || (state === "COMMENTED" && !text(row["body"]).trim())) return [];
    return [
      {
        key: `rv:${idOf(row, "review")}`,
        kind: `review-${state.toLowerCase() || "unknown"}`,
        by: loginOf(row["user"]) ?? "ghost",
        url: text(row["html_url"]),
        body: text(row["body"]),
      },
    ];
  });

const commitAuthors = async (api: Api, root: string): Promise<PrCommitAuthors[]> =>
  (await pages(api, `${root}/commits`, list("commit list"))).map((value) => {
    const row = record(value, "commit list");
    if (typeof row["sha"] !== "string" || !SHA.test(row["sha"])) throw new Error("incomplete commit list");
    const committer = loginOf(row["committer"]);
    const people = [
      loginOf(row["author"]) ?? "unknown",
      ...(committer && committer !== WEB_COMMITTER ? [committer] : []),
    ];
    return { sha: row["sha"], people: [...new Set(people)] };
  });

const failedChecks = async (api: Api, repo: string, head: string): Promise<FailedCheck[]> => {
  const runs: unknown[] = [];
  for (let page = 1; ; page++) {
    const body = record(await api(`repos/${repo}/commits/${head}/check-runs?per_page=100&page=${page}`), "check runs");
    if (!Array.isArray(body["check_runs"]) || !Number.isSafeInteger(body["total_count"]))
      throw new Error("incomplete check runs");
    runs.push(...body["check_runs"]);
    if (body["check_runs"].length < 100 || runs.length >= Number(body["total_count"])) break;
    if (page >= 30) throw new Error("more than 3000 check runs");
  }
  const status = record(await api(`repos/${repo}/commits/${head}/status?per_page=100`), "commit status");
  if (!Array.isArray(status["statuses"])) throw new Error("incomplete commit status");
  return [
    ...runs.flatMap((value) => {
      const row = record(value, "check run");
      const conclusion = text(row["conclusion"]);
      return Object.hasOwn(FAILED_CHECK, conclusion)
        ? [{ key: `ck:${idOf(row, "check run")}`, name: text(row["name"]), conclusion, url: text(row["html_url"]) }]
        : [];
    }),
    ...status["statuses"].flatMap((value) => {
      const row = record(value, "commit status");
      const state = text(row["state"]);
      return Object.hasOwn(FAILED_STATUS, state)
        ? [
            {
              key: `st:${idOf(row, "commit status")}`,
              name: text(row["context"]),
              conclusion: state,
              url: text(row["target_url"]),
            },
          ]
        : [];
    }),
  ];
};

/** Reads everything first, so a failure part-way changes nothing: the caller records a snapshot or nothing. */
export const fetchPr = async (api: Api, ref: PrRef, knownHead: string | undefined): Promise<PrSnapshot> => {
  const root = `repos/${ref.repo}/pulls/${ref.number}`;
  const pr = record(await api(root), "PR metadata");
  const head = (pr["head"] as { sha?: unknown } | null)?.sha;
  if (
    typeof head !== "string" ||
    !SHA.test(head) ||
    (pr["state"] !== "open" && pr["state"] !== "closed") ||
    typeof pr["merged"] !== "boolean"
  )
    throw new Error("incomplete PR metadata");
  const mergeSha = pr["merged"] && typeof pr["merge_commit_sha"] === "string" ? pr["merge_commit_sha"] : undefined;
  const feedback = [
    ...(await comments(api, `${root}/comments`, "review-comment", "rc")),
    ...(await comments(api, `repos/${ref.repo}/issues/${ref.number}/comments`, "comment", "ic")),
    ...(await reviews(api, root)),
  ];
  const commits = head === knownHead ? undefined : await commitAuthors(api, root);
  return {
    state: pr["merged"] ? "merged" : pr["state"] === "open" ? "open" : "closed",
    head,
    url: text(pr["html_url"]),
    ...(mergeSha !== undefined ? { mergeSha } : {}),
    feedback,
    ...(commits !== undefined ? { commits } : {}),
    failed: await failedChecks(api, ref.repo, head),
  };
};
