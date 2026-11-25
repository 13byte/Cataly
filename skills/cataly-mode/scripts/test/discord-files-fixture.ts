/**
 * A loopback Discord REST stand-in for `send discord --file`. The CLI and the native sender it starts post real HTTP
 * requests to it; no request leaves this host and no real token is used. POST answers are served in order; once they
 * run out, or for an `undefined` entry, the message is accepted the way Discord accepts it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ids } from "./discord-fakes.ts";
import { withState } from "./fakes.ts";

export const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type Part = { readonly field: string; readonly filename: string; readonly size: number; readonly sha256: string };
type Upload = {
  readonly authorization: string | null;
  /** The size of the whole request body, as its `Content-Length` declares it. */
  readonly requestBytes: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly parts: readonly Part[];
};
type Answer = { readonly status?: number; readonly body?: unknown } | undefined;
type FilesCli = {
  /** The one configured artifact root. */
  readonly root: string;
  readonly stateDir: string;
  /** Writes a file below the root and returns its path. */
  readonly file: (name: string, content?: string | Uint8Array) => string;
  /** The child sees no native binary unless `environment` names one in `CATALY_DISCORD_NATIVE_BIN`. */
  readonly invoke: (
    args: readonly string[],
    options?: {
      readonly answers?: readonly Answer[];
      readonly environment?: Record<string, string>;
      /** `null` leaves `artifactRoots` out of the configuration. */
      readonly roots?: readonly string[] | null;
    },
  ) => Promise<{ code: number; out: string; err: string; keys: string[]; uploads: Upload[] }>;
};

const channels: Record<string, unknown> = {
  [ids.text]: { id: ids.text, type: 0, name: "chat" },
  [ids.forum]: { id: ids.forum, type: 15, name: "tasks" },
  [ids.thread]: { id: ids.thread, type: 11, parent_id: ids.forum },
};

/** The message Discord returns for an accepted post: every file part becomes an attachment, in order. */
const accepted = (channel: string, upload: Upload) => {
  const reference = upload.payload["message_reference"];
  return {
    id: "71",
    channel_id: channel,
    type: reference === undefined ? 0 : 19,
    ...(reference === undefined ? {} : { message_reference: reference }),
    attachments: upload.parts.map((part, index) => ({
      id: String(900 + index),
      filename: part.filename,
      size: part.size,
    })),
  };
};

/** One recorded message post: a multipart form as Discord reads it, or a plain JSON body. */
const received = async (request: Request): Promise<Upload> => {
  const type = request.headers.get("content-type") ?? "";
  const parts: Part[] = [];
  let payload: unknown;
  if (type.startsWith("multipart/form-data")) {
    const form = await request.formData();
    for (const [field, value] of form.entries()) {
      if (typeof value === "string") {
        if (field === "payload_json") payload = JSON.parse(value);
        continue;
      }
      const bytes = new Uint8Array(await value.arrayBuffer());
      parts.push({ field, filename: value.name, size: bytes.byteLength, sha256: sha256(bytes) });
    }
  } else payload = await request.json();
  return {
    authorization: request.headers.get("authorization"),
    requestBytes: Number(request.headers.get("content-length")),
    type,
    payload: (payload ?? {}) as Record<string, unknown>,
    parts,
  };
};

export const withFilesCli = async (use: (fixture: FilesCli) => Promise<void>): Promise<void> => {
  const state = withState();
  const root = join(state.dir, "files");
  const tmp = join(state.dir, "tmp");
  const config = join(state.dir, "config.json");
  mkdirSync(root);
  mkdirSync(tmp, { mode: 0o700 });
  let answers: Answer[] = [];
  let keys: string[] = [];
  let uploads: Upload[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\/api\/v10/, "");
      keys.push(`${request.method} ${path}`);
      const channel = /^\/channels\/(\d+)(\/messages)?$/.exec(path);
      if (!channel?.[1]) return Response.json({ message: "Unknown" }, { status: 404 });
      const known = request.method === "GET" && !channel[2] ? channels[channel[1]] : undefined;
      if (known) return Response.json(known);
      if (request.method !== "POST" || !channel[2]) return Response.json({ message: "Unknown" }, { status: 404 });
      const upload = await received(request);
      uploads.push(upload);
      const answer = answers.shift();
      return answer === undefined
        ? Response.json(accepted(channel[1], upload))
        : Response.json(answer.body ?? {}, { status: answer.status ?? 200 });
    },
  });
  try {
    await use({
      root,
      stateDir: state.dir,
      file: (name, content = "evidence\n") => {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        return path;
      },
      invoke: async (args, options = {}) => {
        answers = [...(options.answers ?? [])];
        keys = [];
        uploads = [];
        const roots = options.roots === undefined ? [root] : options.roots;
        writeFileSync(
          config,
          JSON.stringify({
            stateDir: state.dir,
            defaultCwd: state.dir,
            ...(roots === null ? {} : { artifactRoots: roots.map((path) => ({ path })) }),
          }),
        );
        const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
          cwd: state.dir,
          env: {
            HOME: state.dir,
            PATH: "/usr/bin:/bin",
            // The OS lookups agree: POSIX reads TMPDIR, Windows reads TEMP (then TMP).
            TMPDIR: tmp,
            TMP: tmp,
            TEMP: tmp,
            CATALY_CONFIG: config,
            CATALY_STATE_DIR: state.dir,
            CATALY_DISCORD_TOKEN: "synthetic-ops-token",
            CATALY_DISCORD_API_BASE: `http://127.0.0.1:${server.port}/api/v10`,
            ...options.environment,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
        });
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { code, out: out.trim(), err: err.trim(), keys, uploads };
      },
    });
  } finally {
    await server.stop(true);
    state.done();
  }
};
