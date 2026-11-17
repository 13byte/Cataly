import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, type Stats } from "node:fs";
import { join } from "node:path";
import { type DiscordInboundStore, fileDiscordInboundStore, isDiscordSnowflake } from "./discord-inbound-state.ts";
import { MessengerError } from "./http.ts";

export type DiscordInboundQueue = {
  push(kind: "sync" | "message", data?: unknown): void;
  first(): { id: number; kind: string; payload: string } | null;
  storeFor(channelId: string): DiscordInboundStore;
  remove(id: number): void;
  close(): void;
};

const storage = <T>(job: () => T): T => {
  try {
    return job();
  } catch (error) {
    if (error instanceof MessengerError) throw error;
    throw new MessengerError(
      "Discord inbound queue storage failed; check ownership, available space, the 256 MiB queue limit and other intake processes",
      0,
    );
  }
};

const privateFile = (stat: Stats) => {
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
    throw new MessengerError("Discord inbound queue must be a private regular file owned by this user", 0);
  }
};

/** Disk-backed FIFO: one decoded record and a bounded SQLite page cache, never one Promise per dispatch. */
export const discordInboundQueue = (stateDir: string): DiscordInboundQueue =>
  storage(() => {
    const dir = join(stateDir, "discord-inbound");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new MessengerError("Discord inbound queue directory must be private (0700) and owned by this user", 0);
    }
    const path = join(dir, "gateway.sqlite");
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing) privateFile(existing);
    else {
      // Closing an ordinary fd for an existing SQLite inode releases this process's other POSIX locks on it.
      const fd = openSync(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
      try {
        privateFile(fstatSync(fd));
      } finally {
        closeSync(fd);
      }
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false });
      if (sidecar) privateFile(sidecar);
    }
    const db = new Database(path);
    try {
      db.exec(
        "PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; " +
          "PRAGMA cache_size=-256; PRAGMA mmap_size=0;",
      );
      const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
      db.exec(`PRAGMA max_page_count=${Math.floor((256 * 1024 * 1024) / pageSize)}`);
      db.exec("CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL)");
      const insert = db.query("INSERT INTO pending (kind, payload) VALUES (?, ?)");
      const first = db.query<{ id: number; kind: string; payload: string }, []>(
        "SELECT id, kind, payload FROM pending ORDER BY id LIMIT 1",
      );
      const remove = db.query("DELETE FROM pending WHERE id = ?");
      const channel = db.query<{ message: unknown }, [string]>(
        "SELECT json_extract(payload, '$.id') AS message FROM pending " +
          "WHERE kind = 'message' AND json_extract(payload, '$.channel_id') = ? ORDER BY pending.id LIMIT 1",
      );
      return {
        push: (kind, data) =>
          storage(() => {
            insert.run(kind, JSON.stringify(data) ?? "null");
          }),
        first: () => storage(() => first.get()),
        storeFor: (channelId) =>
          storage(() => {
            const store = fileDiscordInboundStore(stateDir, channelId);
            if (store.load() === undefined) {
              const id = channel.get(channelId)?.message;
              if (isDiscordSnowflake(id)) store.save(String(BigInt(id) - 1n));
            }
            return store;
          }),
        remove: (id) =>
          storage(() => {
            remove.run(id);
          }),
        close: () => storage(() => db.close()),
      };
    } catch (error) {
      db.close();
      throw error;
    }
  });
