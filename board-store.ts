// board-store.ts — persistent, pull-only public message board for omp sessions.
//
// Storage model: one immutable JSON file per post inside a user-private board
// directory (default: OMP_SESSION_BOARD_DIR, else XDG_STATE_HOME/omp-session-bus/board,
// else ~/.local/state/omp-session-bus/board). There is no manifest, index, or
// lock: the directory listing is the catalog. Posts are published atomically
// (write a unique hidden temp file, then hard-link it to its final id.json
// name), so a reader never observes a partial post. Posts are never updated.
// Expired posts (default TTL 7 days) are excluded from reads immediately and
// removed opportunistically by a publish-time sweep gated by a cross-process
// lease, at most once per day.

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type BoardAuthor = { sessionId: string; name: string; cwd: string };
export type BoardPost = {
  id: string;
  createdAt: string;
  expiresAt: string;
  author: BoardAuthor;
  topic?: string;
  body: string;
};
export type BoardPage = { posts: BoardPost[]; nextCursor?: string };
export type BoardReadOptions = {
  topic?: string;
  query?: string;
  author?: string;
  since?: string;
  before?: string;
  limit?: number;
  directory?: string;
};

const BODY_MAX_BYTES = 16_384;
const TOPIC_MAX_BYTES = 80;
const SESSION_ID_MAX_BYTES = 128;
const AUTHOR_NAME_MAX_BYTES = 256;
const CWD_MAX_BYTES = 1_024;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GC_LEASE_NAME = ".gc-lease";
export type BoardTopicSummary = {
  name: string;
  count: number;
  latestAt: string;
};
export type BoardTopicPage = {
  topics: BoardTopicSummary[];
  nextCursor?: string;
};
export type BoardTopicListOptions = {
  query?: string;
  before?: string;
  limit?: number;
  directory?: string;
};
// Body cap plus metadata headroom; anything larger is foreign or corrupt.
const FILE_MAX_BYTES = 65_536;

// Post ids: 15-digit zero-padded millisecond timestamp + "-" + uuid. The fixed
// width keeps lexicographic id order identical to chronological order, which
// is what makes `before` cursor pagination work. Same-millisecond posts from
// different processes have no defined relative order (they still coexist).
const POST_ID_PATTERN =
  /^\d{15}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NOFOLLOW =
  typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errnoOf = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const compareDescending = (a: string, b: string): number =>
  a < b ? 1 : a > b ? -1 : 0;

const isPostFileName = (name: string): boolean =>
  name.endsWith(".json") && POST_ID_PATTERN.test(name.slice(0, -5));

// Monotonic per-process stamp: bumps by 1ms when the clock has not advanced,
// so posts published back-to-back keep strict newest-last id order.
let lastStampMs = 0;
function nextStampMs(): number {
  const now = Date.now();
  lastStampMs = now > lastStampMs ? now : lastStampMs + 1;
  return lastStampMs;
}

function requireString(value: unknown, what: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new Error(
      `${what} must be a string, got ${value === null ? "null" : typeof value}`,
    );
  }
  if (value.trim() === "") {
    throw new Error(`${what} must not be blank`);
  }
  const bytes = byteLength(value);
  if (bytes > maxBytes) {
    throw new Error(
      `${what} is ${bytes} UTF-8 bytes; the maximum is ${maxBytes}`,
    );
  }
  return value;
}

function resolveBoardDir(directory?: string): string {
  if (directory !== undefined) {
    if (typeof directory !== "string" || directory.trim() === "") {
      throw new Error("directory option must be a nonblank path string");
    }
    return directory;
  }
  const env = process.env;
  const override = env.OMP_SESSION_BOARD_DIR;
  if (override !== undefined && override.trim() !== "") return override;
  const xdg = env.XDG_STATE_HOME;
  if (xdg !== undefined && xdg.trim() !== "") {
    return join(xdg, "omp-session-bus", "board");
  }
  return join(homedir(), ".local", "state", "omp-session-bus", "board");
}

const currentUid = (): number | undefined =>
  typeof process.geteuid === "function" ? process.geteuid() : undefined;

function verifyBoardDir(dir: string, info: Stats): void {
  if (!info.isDirectory()) {
    throw new Error(
      `board directory ${dir} is not a directory (it may be a symlink or a file); refusing to use it. Remove it or set OMP_SESSION_BOARD_DIR to another path.`,
    );
  }
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(
      `board directory ${dir} is owned by uid ${info.uid}, not the current uid ${uid}; refusing to use it. Fix ownership with chown, or set OMP_SESSION_BOARD_DIR to another path.`,
    );
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `board directory ${dir} has group/other permissions (mode ${info.mode.toString(8)}); refusing to use it. Run: chmod 700 ${dir}`,
    );
  }
}

async function ensureBoardDir(dir: string): Promise<void> {
  let info: Stats | undefined;
  try {
    info = await lstat(dir);
  } catch (error) {
    if (errnoOf(error) !== "ENOENT") {
      throw new Error(
        `cannot inspect board directory ${dir}: ${message(error)}`,
      );
    }
  }
  if (info === undefined) {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new Error(
        `cannot create board directory ${dir}: ${message(error)}`,
      );
    }
    try {
      info = await lstat(dir);
    } catch (error) {
      throw new Error(
        `board directory ${dir} disappeared right after creating it: ${message(error)}`,
      );
    }
  }
  verifyBoardDir(dir, info);
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best-effort cleanup of a temp file
  }
}

// Best-effort fsync of the directory so the new link survives a crash.
async function syncDirectoryBestEffort(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // best-effort durability; some platforms cannot fsync a directory
  }
}

function validateAuthor(author: BoardAuthor): BoardAuthor {
  if (!isRecord(author)) {
    throw new Error(
      "author must be an object with sessionId, name, and cwd strings",
    );
  }
  return {
    sessionId: requireString(
      author.sessionId,
      "author.sessionId",
      SESSION_ID_MAX_BYTES,
    ),
    name: requireString(author.name, "author.name", AUTHOR_NAME_MAX_BYTES),
    cwd: requireString(author.cwd, "author.cwd", CWD_MAX_BYTES),
  };
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit)) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  if (limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_LIMIT}, got ${limit}`);
  }
  return limit;
}

function validateBefore(before: string | undefined): string | undefined {
  if (before === undefined) return undefined;
  if (typeof before !== "string" || !POST_ID_PATTERN.test(before)) {
    throw new Error(
      "before must be a nextCursor value previously returned by readPosts (an opaque board post id)",
    );
  }
  return before;
}

function parseStoredPost(name: string, id: string, text: string): BoardPost {
  // Declared as function statements (not const arrows) so TypeScript treats
  // the `: never` returns as narrowing assertions at every call site.
  function fail(why: string): never {
    throw new Error(
      `board post ${name} is malformed (${why}); refusing to silently drop it. Inspect or remove the file, or point OMP_SESSION_BOARD_DIR at a healthy board directory.`,
    );
  }
  function str(value: unknown, what: string, maxBytes: number): string {
    if (typeof value !== "string") {
      fail(
        `${what} is ${value === null ? "null" : typeof value}, expected a string`,
      );
    }
    if (value.trim() === "") fail(`${what} is blank`);
    const bytes = byteLength(value);
    if (bytes > maxBytes) {
      fail(`${what} is ${bytes} UTF-8 bytes, over the ${maxBytes}-byte limit`);
    }
    return value;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`not valid JSON: ${message(error)}`);
  }
  if (!isRecord(parsed)) fail("top-level value is not an object");
  const storedId = str(parsed.id, "id", 64);
  if (storedId !== id) {
    fail(`id "${storedId}" does not match file name "${name}"`);
  }
  const createdAt = str(parsed.createdAt, "createdAt", 40);
  if (Number.isNaN(Date.parse(createdAt))) {
    fail(`createdAt "${createdAt}" is not a valid date`);
  }
  // Posts published before expiresAt existed derive a default TTL from
  // createdAt; the file itself is never rewritten.
  const expiresAt =
    parsed.expiresAt === undefined
      ? new Date(
          Date.parse(createdAt) + DEFAULT_TTL_SECONDS * 1000,
        ).toISOString()
      : str(parsed.expiresAt, "expiresAt", 40);
  if (Number.isNaN(Date.parse(expiresAt))) {
    fail(`expiresAt "${expiresAt}" is not a valid date`);
  }
  if (!isRecord(parsed.author)) fail("author is not an object");
  const author: BoardAuthor = {
    sessionId: str(
      parsed.author.sessionId,
      "author.sessionId",
      SESSION_ID_MAX_BYTES,
    ),
    name: str(parsed.author.name, "author.name", AUTHOR_NAME_MAX_BYTES),
    cwd: str(parsed.author.cwd, "author.cwd", CWD_MAX_BYTES),
  };
  const body = str(parsed.body, "body", BODY_MAX_BYTES);
  const topic =
    parsed.topic === undefined
      ? undefined
      : str(parsed.topic, "topic", TOPIC_MAX_BYTES).trim();
  const post: BoardPost = { id, createdAt, expiresAt, author, body };
  if (topic !== undefined) post.topic = topic;
  return post;
}

async function readPostFile(
  dir: string,
  name: string,
): Promise<BoardPost | undefined> {
  const id = name.slice(0, -".json".length);
  const path = join(dir, name);
  let handle: FileHandle;
  try {
    handle = await open(path, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT") return undefined; // vanished mid-read (e.g. GC)
    if (code === "ELOOP") {
      throw new Error(
        `board post ${name} is a symlink; refusing to follow it. Remove the symlink from the board directory.`,
      );
    }
    throw new Error(`cannot open board post ${name}: ${message(error)}`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(
        `board post ${name} is not a regular file; refusing to read it`,
      );
    }
    const uid = currentUid();
    if (uid !== undefined && info.uid !== uid) {
      throw new Error(
        `board post ${name} is owned by uid ${info.uid}, not the current uid ${uid}; refusing to read it`,
      );
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error(
        `board post ${name} is readable by group/others (mode ${info.mode.toString(8)}); refusing to read it. Run: chmod 600 ${path}`,
      );
    }
    if (info.size > FILE_MAX_BYTES) {
      throw new Error(
        `board post ${name} is ${info.size} bytes, over the ${FILE_MAX_BYTES}-byte cap; it is not a valid board post`,
      );
    }
    const text = await handle.readFile("utf8");
    return parseStoredPost(name, id, text);
  } finally {
    await handle.close();
  }
}

function postMatchesAuthor(post: BoardPost, author: string): boolean {
  return post.author.sessionId === author || post.author.name === author;
}

function postMatchesQuery(post: BoardPost, needle: string): boolean {
  if (post.body.toLowerCase().includes(needle)) return true;
  if (post.topic !== undefined && post.topic.toLowerCase().includes(needle)) {
    return true;
  }
  return post.author.name.toLowerCase().includes(needle);
}

// Opportunistic expired-post cleanup. Cross-process pacing: the lease is an
// immutable file named for the current calendar day (UTC), e.g. ".gc-2026-10-27".
// A process acquires it with a no-overwrite link, so exactly one process
// sweeps per calendar day; leases are never unlinked or rewritten, which
// removes the unlink/recreate race. Leases from prior days are removed
// opportunistically by the day's winner, after acquiring the new lease.
// Only files verified by the same strict read path as readPosts AND already
// expired are removed; anything malformed, foreign, or a symlink is left
// alone. Failures are swallowed by the caller.
async function gcExpiredPosts(dir: string): Promise<void> {
  const nowMs = Date.now();
  const day = new Date(nowMs).toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const leasePath = join(dir, `.gc-${day}`);

  let acquired = false;
  const leaseTemp = join(dir, `.${randomUUID()}.tmp`);
  try {
    const handle = await open(leaseTemp, "wx", 0o600);
    try {
      await handle.writeFile(new Date(nowMs).toISOString(), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(leaseTemp, leasePath);
      acquired = true;
    } catch (error) {
      if (errnoOf(error) !== "EEXIST") throw error;
      // today's lease already exists: another process swept (or is sweeping)
    }
  } finally {
    await removeQuietly(leaseTemp);
  }
  if (!acquired) return;

  // We hold today's lease: sweep expired posts, then tidy older lease files.
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names.filter(isPostFileName).sort(compareDescending)) {
    let post: BoardPost | undefined;
    try {
      post = await readPostFile(dir, name);
    } catch {
      continue; // never delete what we could not verify as a post
    }
    if (post === undefined) continue; // vanished mid-sweep; not ours to unlink
    if (Date.parse(post.expiresAt) > nowMs) continue;
    const target = join(dir, name);
    let targetInfo: Stats | undefined;
    try {
      targetInfo = await lstat(target);
    } catch {
      continue;
    }
    if (!targetInfo.isFile()) continue;
    try {
      await unlink(target);
    } catch {
      // someone else removed it first; fine
    }
  }
  for (const name of names) {
    if (name === leasePath.slice(dir.length + 1)) continue;
    if (!/^\.gc-\d{4}-\d{2}-\d{2}$/.test(name) || name >= `.gc-${day}`)
      continue;
    try {
      await unlink(join(dir, name));
    } catch {
      // best-effort removal of a prior-day lease
    }
  }
}

export async function publishPost(
  author: BoardAuthor,
  body: string,
  topic?: string,
  directory?: string,
  ttlSeconds?: number,
): Promise<BoardPost> {
  const safeAuthor = validateAuthor(author);
  const safeBody = requireString(body, "body", BODY_MAX_BYTES);
  const safeTopic =
    topic === undefined
      ? undefined
      : requireString(topic, "topic", TOPIC_MAX_BYTES).trim();
  if (
    ttlSeconds !== undefined &&
    (typeof ttlSeconds !== "number" ||
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > MAX_TTL_SECONDS)
  ) {
    throw new Error(
      `ttlSeconds must be a positive integer between 1 and ${MAX_TTL_SECONDS} (365 days), got ${ttlSeconds}`,
    );
  }
  const ttlMs = (ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;

  const dir = resolveBoardDir(directory);
  await ensureBoardDir(dir);

  let lastFailure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stampMs = nextStampMs();
    const id = `${String(stampMs).padStart(15, "0")}-${randomUUID()}`;
    const createdAt = new Date(stampMs).toISOString();
    const expiresAt = new Date(stampMs + ttlMs).toISOString();
    const post: BoardPost =
      safeTopic === undefined
        ? { id, createdAt, expiresAt, author: safeAuthor, body: safeBody }
        : {
            id,
            createdAt,
            expiresAt,
            author: safeAuthor,
            topic: safeTopic,
            body: safeBody,
          };
    const payload = JSON.stringify(post);
    const tempPath = join(dir, `.${randomUUID()}.tmp`);
    const finalPath = join(dir, `${id}.json`);
    try {
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // link fails with EEXIST if the final name is taken: never overwrites.
      await link(tempPath, finalPath);
      await removeQuietly(tempPath); // the link is now the durable copy
      await syncDirectoryBestEffort(dir);
      try {
        await gcExpiredPosts(dir);
      } catch {
        // opportunistic cleanup; never fail a committed publication
      }
      return post;
    } catch (error) {
      await removeQuietly(tempPath);
      if (errnoOf(error) !== "EEXIST") {
        throw new Error(
          `failed to publish board post to ${finalPath}: ${message(error)}`,
        );
      }
      lastFailure = error; // id collision: retry with a fresh uuid
    }
  }
  throw new Error(
    `could not publish a board post in ${dir} after 3 attempts (post id collisions?): ${message(lastFailure)}`,
  );
}

export async function readPosts(
  options?: BoardReadOptions,
): Promise<BoardPage> {
  const opts: BoardReadOptions = options ?? {};
  const topic =
    opts.topic === undefined
      ? undefined
      : requireString(opts.topic, "topic", TOPIC_MAX_BYTES).trim();
  const query =
    opts.query === undefined
      ? undefined
      : requireString(opts.query, "query", 1_024).trim();
  const author =
    opts.author === undefined
      ? undefined
      : requireString(opts.author, "author", AUTHOR_NAME_MAX_BYTES).trim();
  let sinceMs: number | undefined;
  if (opts.since !== undefined) {
    const since = requireString(opts.since, "since", 40);
    // ISO8601 with an explicit UTC designator or numeric offset; a bare
    // local-time value would silently shift the window per host timezone.
    if (!/(?:Z|[+-]\d\d:\d\d)$/.test(since)) {
      throw new Error(
        "since must be an ISO8601 timestamp ending in Z or a numeric UTC offset",
      );
    }
    sinceMs = Date.parse(since);
    if (Number.isNaN(sinceMs)) {
      throw new Error(`since is not a valid timestamp: ${since}`);
    }
  }
  const before = validateBefore(opts.before);
  const limit = validateLimit(opts.limit);
  const dir = resolveBoardDir(opts.directory);

  // Safety gate first: never list or read through a symlinked or foreign dir.
  let info: Stats;
  try {
    info = await lstat(dir);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { posts: [] };
    throw new Error(`cannot inspect board directory ${dir}: ${message(error)}`);
  }
  verifyBoardDir(dir, info);

  // Snapshot file names exactly once; posts published after this point are
  // simply not part of this read.
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { posts: [] };
    throw new Error(`cannot list board directory ${dir}: ${message(error)}`);
  }

  const needle = query === undefined ? undefined : query.toLowerCase();
  const posts: BoardPost[] = [];
  for (const name of names.filter(isPostFileName).sort(compareDescending)) {
    const id = name.slice(0, -".json".length);
    if (before !== undefined && id >= before) continue; // exclusive cursor
    const post = await readPostFile(dir, name);
    if (post === undefined) continue; // vanished mid-read (e.g. GC)
    if (topic !== undefined && post.topic !== topic) continue;
    if (Date.parse(post.expiresAt) <= Date.now()) continue; // expired
    if (author !== undefined && !postMatchesAuthor(post, author)) continue;
    if (sinceMs !== undefined && Date.parse(post.createdAt) < sinceMs) continue;
    if (needle !== undefined && !postMatchesQuery(post, needle)) continue;
    posts.push(post);
    if (posts.length === limit + 1) break; // one extra proves more matches exist
  }
  if (posts.length <= limit) return { posts };
  const page = posts.slice(0, limit);
  return { posts: page, nextCursor: page[page.length - 1].id };
}

// Topic listing over unexpired posts. Pagination is by alphabetic topic
// name: `before` is an exclusive cursor holding a previous page's last
// returned name (despite the option name, it is a topic name, not a post id).
export async function listTopics(
  options?: BoardTopicListOptions,
): Promise<BoardTopicPage> {
  const opts: BoardTopicListOptions = options ?? {};
  const query =
    opts.query === undefined
      ? undefined
      : requireString(opts.query, "query", 1_024).trim();
  if (
    opts.before !== undefined &&
    (typeof opts.before !== "string" || opts.before.trim() === "")
  ) {
    throw new Error("before must be a nonblank topic name cursor string");
  }
  const before = opts.before === undefined ? undefined : opts.before.trim();
  const limit = validateLimit(opts.limit);
  const dir = resolveBoardDir(opts.directory);

  let info: Stats;
  try {
    info = await lstat(dir);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { topics: [] };
    throw new Error(`cannot inspect board directory ${dir}: ${message(error)}`);
  }
  verifyBoardDir(dir, info);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { topics: [] };
    throw new Error(`cannot list board directory ${dir}: ${message(error)}`);
  }

  // Aggregate exact topic names across unexpired posts.
  const stats = new Map<string, { count: number; latestMs: number }>();
  const nowMs = Date.now();
  for (const name of names.filter(isPostFileName).sort(compareDescending)) {
    const post = await readPostFile(dir, name);
    if (post === undefined) continue; // vanished mid-read (e.g. GC)
    if (post.topic === undefined) continue;
    if (Date.parse(post.expiresAt) <= nowMs) continue;
    const entry = stats.get(post.topic);
    const postMs = Date.parse(post.createdAt);
    if (entry === undefined) {
      stats.set(post.topic, { count: 1, latestMs: postMs });
    } else {
      entry.count += 1;
      if (postMs > entry.latestMs) entry.latestMs = postMs;
    }
  }

  let sorted = [...stats.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (query !== undefined) {
    const needle = query.toLowerCase();
    sorted = sorted.filter((name) => name.toLowerCase().includes(needle));
  }
  // `before` is an exclusive alphabetic cursor: topics sort ascending, so
  // the next page is everything AFTER the cursor name.
  if (before !== undefined) sorted = sorted.filter((name) => name > before);
  if (sorted.length <= limit) {
    return {
      topics: sorted.map((name) => {
        const entry = stats.get(name)!;
        return {
          name,
          count: entry.count,
          latestAt: new Date(entry.latestMs).toISOString(),
        };
      }),
    };
  }
  const pageNames = sorted.slice(0, limit);
  return {
    topics: pageNames.map((name) => {
      const entry = stats.get(name)!;
      return {
        name,
        count: entry.count,
        latestAt: new Date(entry.latestMs).toISOString(),
      };
    }),
    nextCursor: pageNames[pageNames.length - 1],
  };
}
