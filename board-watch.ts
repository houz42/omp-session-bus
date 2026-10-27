import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import {
  openBoardReader,
  normalizeBoardFilters,
  matchesBoardFilters,
  type BoardPost,
} from "./board-store.ts";

type Filters = { topic?: string; query?: string; author?: string };
type BoardReader = {
  directory: string;
  snapshot(): Promise<string[]>;
  read(id: string): Promise<BoardPost | undefined>;
};
export type BoardWatch = {
  id: string;
  from: string;
  grep?: string;
  author?: string;
  createdAt: string;
  expiresAt?: string;
};
type WatchEntry = { info: BoardWatch; filters: Filters; seen: Set<string> };
type Options = {
  sessionId: string;
  directory?: string;
  deliver(posts: BoardPost[]): void;
  onError(error: Error): void;
};
const MAX_WATCHES = 64;
const BATCH_MS = 200;
const RECONCILE_MS = 2000;
const MAX_BATCH_BYTES = 64 * 1024;

/** Session-local subscriptions. Filesystem events are hints; committed files remain authoritative. */
export class BoardWatcher {
  #reader: BoardReader;
  #options: Options;
  #entries = new Map<string, WatchEntry>();
  #delivered = new Set<string>();
  #closed = false;
  #fs?: FSWatcher;
  #timer?: NodeJS.Timeout;
  #interval?: NodeJS.Timeout;
  #tail: Promise<void> = Promise.resolve();
  #backgroundScan = false;
  #dirty = false;

  private constructor(reader: BoardReader, options: Options) {
    this.#reader = reader;
    this.#options = options;
  }
  static async create(options: Options): Promise<BoardWatcher> {
    return new BoardWatcher(await openBoardReader(options.directory), options);
  }

  async add(options: {
    from: string;
    grep?: string;
    author?: string;
    ttl?: number;
  }): Promise<BoardWatch> {
    if (
      typeof options.from !== "string" ||
      !options.from.startsWith("board:") ||
      !options.from.slice(6).trim()
    )
      throw new Error("watch requires from:board:<topic> or board:all");
    const topic = options.from.slice(6).trim();
    const filters = normalizeBoardFilters({
      topic: topic === "all" ? undefined : topic,
      query: options.grep,
      author: options.author,
    });
    if (
      options.ttl !== undefined &&
      (!Number.isInteger(options.ttl) ||
        options.ttl < 1 ||
        options.ttl > 31536000)
    )
      throw new Error("Watch ttl must be integer seconds 1..31536000");
    const operation = this.#tail.then(async () => {
      if (this.#closed)
        throw new Error("Board subscriptions are closed for this session");
      this.#prune();
      if (this.#entries.size >= MAX_WATCHES)
        throw new Error(
          `At most ${MAX_WATCHES} active board watches per session`,
        );
      this.#listen();
      // Snapshot after listening. Everything in this snapshot is historical; a commit
      // absent here is picked up by the scheduled scan even if its event raced setup.
      const ids = await this.#reader.snapshot();
      if (this.#closed)
        throw new Error("Session ended while registering board watch");
      const now = Date.now();
      const info: BoardWatch = {
        id: randomUUID(),
        from: `board:${topic}`,
        ...(filters.query === undefined ? {} : { grep: filters.query }),
        ...(filters.author === undefined ? {} : { author: filters.author }),
        createdAt: new Date(now).toISOString(),
        ...(options.ttl === undefined
          ? {}
          : { expiresAt: new Date(now + options.ttl * 1000).toISOString() }),
      };
      this.#entries.set(info.id, { info, filters, seen: new Set(ids) });
      this.#schedule();
      return { ...info };
    });
    this.#tail = operation.then(
      () => {},
      () => {
        if (!this.#entries.size) this.#stopListening();
      },
    );
    return operation;
  }

  list(): BoardWatch[] {
    this.#prune();
    return [...this.#entries.values()].map((entry) => ({ ...entry.info }));
  }
  remove(id: string): boolean {
    this.#prune();
    const removed = this.#entries.delete(id);
    if (!this.#entries.size) this.#stopListening();
    return removed;
  }
  close(): void {
    this.#closed = true;
    this.#entries.clear();
    this.#delivered.clear();
    this.#stopListening();
  }

  /** Serialize reconciliation with registration; also useful for deterministic integration tests. */
  refresh(): Promise<void> {
    const operation = this.#tail.then(() => this.#scan());
    this.#tail = operation.catch(() => {});
    return operation;
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.#entries)
      if (entry.info.expiresAt && Date.parse(entry.info.expiresAt) <= now)
        this.#entries.delete(id);
    if (!this.#entries.size) this.#stopListening();
  }
  #stopListening(): void {
    this.#fs?.close();
    this.#fs = undefined;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    clearInterval(this.#interval);
    this.#interval = undefined;
  }
  #fail(error: unknown): void {
    if (this.#closed) return;
    this.close();
    // Detached callbacks must never propagate an exception into omp's process.
    try {
      this.#options.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
    } catch {}
  }
  #schedule(): void {
    if (this.#closed || this.#timer) return;
    if (this.#backgroundScan) {
      this.#dirty = true;
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#backgroundScan = true;
      void this.refresh()
        .catch((error) => this.#fail(error))
        .finally(() => {
          this.#backgroundScan = false;
          if (this.#dirty && !this.#closed && this.#entries.size) {
            this.#dirty = false;
            this.#schedule();
          }
        });
    }, BATCH_MS);
    this.#timer.unref();
  }
  #listen(): void {
    if (this.#fs || this.#closed) return;
    this.#fs = watch(this.#reader.directory, { persistent: false }, () =>
      this.#schedule(),
    );
    this.#fs.on("error", (error) => this.#fail(error));
    // Some platforms coalesce/drop fs events. This plugin-local reconciliation
    // never blocks the agent or requires model polling.
    this.#interval = setInterval(() => this.#schedule(), RECONCILE_MS);
    this.#interval.unref();
  }
  async #scan(): Promise<void> {
    this.#prune();
    if (this.#closed || !this.#entries.size) return;
    const ids = await this.#reader.snapshot();
    if (this.#closed) return;
    const present = new Set(ids);
    for (const id of this.#delivered)
      if (!present.has(id)) this.#delivered.delete(id);
    for (const entry of this.#entries.values())
      for (const id of entry.seen) if (!present.has(id)) entry.seen.delete(id);
    let batch: Array<{ post: BoardPost; entries: WatchEntry[] }> = [];
    let bytes = 0;
    const stillMatches = (post: BoardPost, entries: WatchEntry[]) =>
      Date.parse(post.expiresAt) > Date.now() &&
      entries.some(
        (entry) =>
          this.#entries.get(entry.info.id) === entry &&
          (!entry.info.expiresAt ||
            Date.parse(entry.info.expiresAt) > Date.now()) &&
          matchesBoardFilters(post, entry.filters),
      );
    const flush = () => {
      if (this.#closed) return;
      const posts = batch
        .filter((item) => stillMatches(item.post, item.entries))
        .map((item) => item.post);
      if (posts.length) this.#options.deliver(posts);
      for (const post of posts) this.#delivered.add(post.id);
      batch = [];
      bytes = 0;
    };
    for (const id of ids.sort()) {
      if (this.#closed) return;
      const interested = [...this.#entries.values()].filter(
        (entry) => !entry.seen.has(id),
      );
      if (!interested.length) continue;
      const post = await this.#reader.read(id);
      if (this.#closed) return;
      for (const entry of interested) entry.seen.add(id);
      if (
        !post ||
        Date.parse(post.expiresAt) <= Date.now() ||
        post.author.sessionId === this.#options.sessionId ||
        this.#delivered.has(id)
      )
        continue;
      if (!stillMatches(post, interested)) continue;
      const size = Buffer.byteLength(JSON.stringify(post));
      if (
        batch.length >= 20 ||
        (batch.length && bytes + size > MAX_BATCH_BYTES)
      )
        flush();
      batch.push({ post, entries: interested });
      bytes += size;
    }
    flush();
  }
}
