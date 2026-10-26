import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  publishPost,
  readPosts,
  listTopics,
  type BoardAuthor,
  type BoardPost,
} from "./board-store.ts";

const POST_FILE =
  /^\d{15}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

const author = (name: string): BoardAuthor => ({
  sessionId: `sess-${name}`,
  name,
  cwd: `/work/${name}`,
});

/** Fresh per-test board directory (mode 0700, owned by us), removed after. */
function makeDir(t: test.TestContext, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `board-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Only real post files — the sweep's day markers and temps are dotfiles. */
const postFiles = (dir: string): string[] =>
  readdirSync(dir).filter((name) => POST_FILE.test(name));

/**
 * Hand-writes a post file with a valid board id, as if left by a prior
 * process: 15-digit ms stamp + fixed uuid, mode 0600. `expiresAt` may be
 * omitted to model a post published before the field existed.
 */
function handWritePost(
  dir: string,
  stampMs: number,
  fields: { body: string; topic?: string; expiresAt?: string; uuid?: string },
): string {
  const id = `${String(stampMs).padStart(15, "0")}-${fields.uuid ?? "00000000-0000-4000-8000-000000000000"}`;
  const record: Record<string, unknown> = {
    id,
    createdAt: new Date(stampMs).toISOString(),
    author: author("scribe"),
    body: fields.body,
  };
  if (fields.topic !== undefined) record.topic = fields.topic;
  if (fields.expiresAt !== undefined) record.expiresAt = fields.expiresAt;
  const file = path.join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify(record));
  chmodSync(file, 0o600);
  return id;
}

/** Drains a filtered read into newest-first pages; every match appears once. */
async function collectAll(
  dir: string,
  options: {
    topic?: string;
    query?: string;
    author?: string;
    since?: string;
    limit?: number;
  } = {},
): Promise<BoardPost[]> {
  const seen: BoardPost[] = [];
  const seenIds = new Set<string>();
  let before: string | undefined;
  for (;;) {
    const page = await readPosts({ ...options, before, directory: dir });
    for (const post of page.posts) {
      assert.ok(!seenIds.has(post.id), `post ${post.id} returned twice`);
      seenIds.add(post.id);
      seen.push(post);
    }
    if (!page.nextCursor) break;
    before = page.nextCursor;
  }
  assert.ok(seen.length > 0, "expected at least one match");
  return seen;
}

const DAY_MS = 24 * 60 * 60 * 1000;

test("publish is atomic: concurrent writers never clobber and every post survives a paged reread", async (t) => {
  const dir = makeDir(t, "atomic");
  const writers = 25;
  const bodies = Array.from({ length: writers }, (_, i) => `body-${i}`);
  const posts = await Promise.all(
    bodies.map((body) => publishPost(author("w"), body, "race", dir)),
  );

  assert.equal(new Set(posts.map((p) => p.id)).size, writers);
  assert.equal(new Set(posts.map((p) => p.body)).size, writers);

  // Every non-hidden directory entry is a complete, valid, id-named post: no
  // torn writes, no clobbered overwrites, no leftover temp files.
  const names = readdirSync(dir).filter((name) => !name.startsWith("."));
  assert.equal(names.length, writers);
  assert.ok(names.every((name) => POST_FILE.test(name)));
  for (const post of posts) {
    const raw = JSON.parse(
      readFileSync(path.join(dir, `${post.id}.json`), "utf8"),
    );
    assert.equal(raw.body, post.body);
    assert.equal(raw.id, post.id);
  }

  // All 25 distinct bodies come back through the storage's own paged read.
  const readBack = await collectAll(dir, { topic: "race", limit: 5 });
  assert.deepEqual(readBack.map((p) => p.body).sort(), [...bodies].sort());
});

test("topic, query, author, and since filter independently and combine as an AND", async (t) => {
  const dir = makeDir(t, "filters");
  const a1 = await publishPost(
    author("alice"),
    "standup notes for Alice",
    "Alpha",
    dir,
  );
  const a2 = await publishPost(
    author("alice"),
    "ALPHA keyword in body",
    "beta",
    dir,
  );
  await publishPost(author("Bob"), "bob report", "Alpha", dir);
  await publishPost(author("Bob"), "keyword alice lower", "gamma", dir);
  await publishPost(author("anna"), "anna says", "Alpha", dir);

  const bodiesOf = (page: { posts: BoardPost[] }) =>
    page.posts.map((p) => p.body);

  // topic is an exact, case-sensitive match on the topic field only.
  assert.deepEqual(
    bodiesOf(await readPosts({ topic: "Alpha", directory: dir })),
    ["anna says", "bob report", "standup notes for Alice"],
  );
  assert.equal(
    (await readPosts({ topic: "alpha", directory: dir })).posts.length,
    0,
  );

  // query is a case-insensitive literal substring over body/topic/author.name.
  assert.deepEqual(
    (await collectAll(dir, { query: "alpha", limit: 1 })).map((p) => p.body),
    [
      "anna says",
      "bob report",
      "ALPHA keyword in body",
      "standup notes for Alice",
    ],
  );
  // "alice" hits bodies and author.name, but never any topic name.
  assert.deepEqual(
    (await collectAll(dir, { query: "alice", limit: 2 }))
      .map((p) => p.body)
      .sort(),
    [
      "ALPHA keyword in body",
      "keyword alice lower",
      "standup notes for Alice",
    ].sort(),
  );
  // Regex metacharacters stay literal: ".*" matches nothing real.
  assert.equal(
    (await readPosts({ query: ".*", directory: dir })).posts.length,
    0,
  );

  // author is exact (case-sensitive) on sessionId OR name.
  assert.deepEqual(
    bodiesOf(await readPosts({ author: "alice", directory: dir })),
    ["ALPHA keyword in body", "standup notes for Alice"],
  );
  assert.deepEqual(
    bodiesOf(await readPosts({ author: "sess-Bob", directory: dir })),
    ["keyword alice lower", "bob report"],
  );
  assert.equal(
    (await readPosts({ author: "ALICE", directory: dir })).posts.length,
    0,
  );

  // since is inclusive on createdAt and honors explicit UTC offsets.
  const sincePage = await readPosts({ since: a2.createdAt, directory: dir });
  assert.deepEqual(bodiesOf(sincePage), [
    "anna says",
    "keyword alice lower",
    "bob report",
    "ALPHA keyword in body",
  ]);
  // The same instant written with a -05:00 numeric offset must behave
  // identically to the Z form (offset-ignoring parsing would shift the
  // window five hours and drop the boundary post).
  const offsetSince = new Date(Date.parse(a2.createdAt) - 5 * 3600_000)
    .toISOString()
    .replace("Z", "-05:00");
  assert.deepEqual(
    bodiesOf(await readPosts({ since: offsetSince, directory: dir })),
    bodiesOf(sincePage),
  );

  // Combined filters intersect: only alice's standup post in topic Alpha.
  assert.deepEqual(
    bodiesOf(
      await readPosts({
        topic: "Alpha",
        author: "alice",
        query: "standup",
        since: a1.createdAt,
        directory: dir,
      }),
    ),
    ["standup notes for Alice"],
  );

  // Invalid since values reject instead of quietly matching everything.
  await assert.rejects(readPosts({ since: "not-a-date", directory: dir }));
  await assert.rejects(
    readPosts({ since: "2026-01-01T00:00:00", directory: dir }),
  );
});

test("pages are newest-first with an exclusive before cursor; nextCursor only when another match follows", async (t) => {
  const dir = makeDir(t, "pagination");
  const seeded: BoardPost[] = [];
  for (let i = 0; i < 3; i++) {
    seeded.push(
      await publishPost(author("seeder"), `post-${i}`, `t-${i}`, dir),
    );
  }
  const all = await readPosts({ directory: dir, limit: 50 });
  assert.deepEqual(
    all.posts.map((p) => p.id),
    [...seeded].reverse().map((p) => p.id),
  );
  assert.equal(all.nextCursor, undefined);

  const page1 = await readPosts({ directory: dir, limit: 2 });
  assert.deepEqual(
    page1.posts.map((p) => p.id),
    [all.posts[0].id, all.posts[1].id],
  );
  assert.equal(page1.nextCursor, page1.posts[1].id);

  // before is exclusive: the cursor post itself never repeats.
  const page2 = await readPosts({
    directory: dir,
    limit: 2,
    before: page1.nextCursor,
  });
  assert.deepEqual(
    page2.posts.map((p) => p.id),
    [all.posts[2].id],
  );
  assert.equal(page2.nextCursor, undefined);

  // The cursor reflects the filtered stream: nothing older matches t-1.
  const tail = await readPosts({
    directory: dir,
    topic: "t-1",
    before: page1.nextCursor,
  });
  assert.equal(tail.posts.length, 0);
  assert.equal(tail.nextCursor, undefined);

  // A cursor at the oldest post exhausts the board.
  const empty = await readPosts({ directory: dir, before: seeded[0].id });
  assert.equal(empty.posts.length, 0);
  assert.equal(empty.nextCursor, undefined);

  // Garbage cursors and out-of-range limits reject loudly.
  await assert.rejects(
    readPosts({ before: "zz-not-a-cursor", directory: dir }),
  );
  await assert.rejects(readPosts({ limit: 0, directory: dir }));
  await assert.rejects(readPosts({ limit: 51, directory: dir }));
  assert.equal(
    (await readPosts({ limit: 50, directory: dir })).posts.length,
    3,
  );
});

test("posts persist across calls: a default-directory caller sees another caller's board", async (t) => {
  const dir = makeDir(t, "persist");
  await publishPost(author("first"), "hello board", "greet", dir);

  const saved = process.env.OMP_SESSION_BOARD_DIR;
  process.env.OMP_SESSION_BOARD_DIR = dir;
  try {
    // Neither call passes a directory: resolution goes through the env var,
    // exactly as an independent process on this machine would resolve it.
    const page = await readPosts({ limit: 50 });
    assert.equal(page.posts.length, 1);
    assert.equal(page.posts[0].body, "hello board");
    assert.equal(page.posts[0].topic, "greet");

    await publishPost(author("late"), "second hello");
    const after = await readPosts({ limit: 50 });
    assert.deepEqual(
      after.posts.map((p) => p.body),
      ["second hello", "hello board"],
    );
  } finally {
    if (saved === undefined) delete process.env.OMP_SESSION_BOARD_DIR;
    else process.env.OMP_SESSION_BOARD_DIR = saved;
  }
});

test("unsafe board directories reject for both publish and read", async (t) => {
  const parent = makeDir(t, "unsafedir");

  // Group/other-readable directory: refused before any file is touched.
  const open = mkdtempSync(path.join(tmpdir(), "board-open-"));
  chmodSync(open, 0o755);
  t.after(() => {
    chmodSync(open, 0o700);
    rmSync(open, { recursive: true, force: true });
  });
  await assert.rejects(publishPost(author("x"), "hi", undefined, open));
  await assert.rejects(readPosts({ directory: open }));
  assert.equal(readdirSync(open).length, 0);

  // A symlinked directory path is not trusted.
  const real = mkdtempSync(path.join(tmpdir(), "board-real-"));
  t.after(() => rmSync(real, { recursive: true, force: true }));
  const link = path.join(parent, "board-link");
  symlinkSync(real, link);
  await assert.rejects(publishPost(author("x"), "hi", undefined, link));
  await assert.rejects(readPosts({ directory: link }));

  // A regular file where the directory should be.
  const fileAsDir = path.join(parent, "not-a-dir");
  writeFileSync(fileAsDir, "x");
  await assert.rejects(publishPost(author("x"), "hi", undefined, fileAsDir));
  await assert.rejects(readPosts({ directory: fileAsDir }));
});

test("symlinked and malformed post files fail the whole read instead of being served", async (t) => {
  const dir = makeDir(t, "badposts");
  await publishPost(author("seed"), "legit post", undefined, dir);

  // A valid-named post file that is actually a symlink, even to good JSON.
  const target = path.join(dir, "target.json");
  writeFileSync(
    target,
    JSON.stringify({
      id: "0",
      createdAt: new Date().toISOString(),
      author: author("x"),
      body: "smuggled",
    }),
  );
  symlinkSync(
    target,
    path.join(
      dir,
      `${"0".padStart(15, "0")}-00000000-0000-4000-8000-000000000001.json`,
    ),
  );
  await assert.rejects(readPosts({ directory: dir }));

  // Same for a symlink escaping the board directory entirely.
  const outside = mkdtempSync(path.join(tmpdir(), "board-out-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const evil = path.join(outside, "evil.json");
  writeFileSync(evil, "garbage");
  symlinkSync(
    evil,
    path.join(
      dir,
      `${"0".padStart(15, "0")}-00000000-0000-4000-8000-000000000002.json`,
    ),
  );
  await assert.rejects(readPosts({ directory: dir }));

  // Once the symlinks are gone, a corrupt file is reported, not dropped.
  for (const name of postFiles(dir)) unlinkSync(path.join(dir, name));
  const corruptId = `${"0".padStart(15, "0")}-00000000-0000-4000-8000-000000000003`;
  const corrupt = path.join(dir, `${corruptId}.json`);
  writeFileSync(corrupt, "{ not json");
  chmodSync(corrupt, 0o600);
  await assert.rejects(readPosts({ directory: dir }), (error: Error) =>
    error.message.includes(corruptId),
  );
});

test("blank, oversized, and invalid inputs reject without leaving a visible post", async (t) => {
  const dir = makeDir(t, "validate");
  await publishPost(author("v"), "base post", undefined, dir);
  const before = postFiles(dir).length;

  const badBodies = ["", "   \n\t ", "x".repeat(16_385)];
  for (const body of badBodies) {
    await assert.rejects(publishPost(author("v"), body, "t", dir));
  }
  // 16_384 bytes is exactly at the cap; 5462 "€" chars are 16_386 UTF-8 bytes.
  await assert.rejects(publishPost(author("v"), "€".repeat(5462), "t", dir));
  await publishPost(author("v"), "y".repeat(16_384), "t", dir);

  await assert.rejects(publishPost(author("v"), "ok body", "  ", dir));
  await assert.rejects(
    publishPost(author("v"), "ok body", "t".repeat(81), dir),
  );

  for (const ttl of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    31_536_001,
  ]) {
    await assert.rejects(
      publishPost(author("v"), "ok body", undefined, dir, ttl),
    );
  }

  // Only the two valid publishes landed.
  assert.equal(postFiles(dir).length, before + 1);
  const page = await readPosts({ directory: dir, limit: 50 });
  assert.equal(page.posts.length, 2);
  assert.ok(page.posts.some((p) => p.body === "y".repeat(16_384)));
});

test("expired posts vanish from reads and topic counts; the sweep deletes only them", async (t) => {
  const dir = makeDir(t, "expiry");
  const sentinel = await publishPost(author("a"), "sentinel", "stay", dir);
  const keeper = await publishPost(author("a"), "keeper", "gone", dir);

  // The TTL contract is observable on the returned post: 7-day default,
  // explicit values honored exactly.
  assert.equal(
    Date.parse(keeper.expiresAt) - Date.parse(keeper.createdAt),
    7 * DAY_MS,
  );
  const fiveMin = await publishPost(author("a"), "short", "stay", dir, 300);
  assert.equal(
    Date.parse(fiveMin.expiresAt) - Date.parse(fiveMin.createdAt),
    300_000,
  );

  // A genuinely expired post, as a prior day's process would have left it.
  const deadId = handWritePost(dir, Date.now() - DAY_MS, {
    body: "expired entry",
    topic: "gone",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    uuid: "00000000-0000-4000-8000-000000000020",
  });

  // Reads and topic counts exclude the expired post; everything else intact.
  const page = await readPosts({ directory: dir, limit: 50 });
  assert.equal(page.posts.length, 3);
  assert.ok(page.posts.every((post) => post.id !== deadId));
  assert.deepEqual(await listTopics({ directory: dir }), {
    topics: [
      { name: "gone", count: 1, latestAt: keeper.createdAt },
      { name: "stay", count: 2, latestAt: fiveMin.createdAt },
    ],
  });

  // Force the publish-time sweep by clearing its day markers, then publish:
  // the sweep deletes exactly the expired post's file and nothing else.
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".gc-")) unlinkSync(path.join(dir, name));
  }
  await publishPost(author("a"), "trigger", "stay", dir);

  const remaining = new Set(postFiles(dir));
  assert.ok(!remaining.has(`${deadId}.json`), "expired post file must be gone");
  assert.equal(remaining.size, 4);
  const final = await readPosts({ directory: dir, limit: 50 });
  assert.deepEqual(
    final.posts.map((p) => p.body),
    ["trigger", "short", "keeper", "sentinel"],
  );
  assert.ok(
    final.posts.every(
      (post) => Date.parse(post.expiresAt) > Date.parse(post.createdAt),
    ),
  );
});

test("legacy posts without expiresAt derive the 7-day default from createdAt", async (t) => {
  const dir = makeDir(t, "legacy");
  const fresh = await publishPost(author("a"), "fresh", undefined, dir);

  const oldId = handWritePost(dir, Date.now() - 8 * DAY_MS, {
    body: "ancient",
    uuid: "00000000-0000-4000-8000-000000000010",
  });
  const recentId = handWritePost(dir, Date.now() - 3_600_000, {
    body: "recent legacy",
    uuid: "00000000-0000-4000-8000-000000000011",
  });

  const page = await readPosts({ directory: dir, limit: 50 });
  const ids = new Set(page.posts.map((post) => post.id));
  assert.ok(!ids.has(oldId), "8-day-old legacy post must be expired");
  assert.ok(ids.has(recentId), "1-hour-old legacy post must still be visible");
  assert.ok(ids.has(fresh.id));
  assert.equal(page.posts.length, 2);
});

test("listTopics counts, searches, and paginates active topics alphabetically", async (t) => {
  const dir = makeDir(t, "topics");
  await publishPost(author("a"), "one", "alpha", dir);
  const a2 = await publishPost(author("a"), "two", "alpha", dir);
  const b1 = await publishPost(author("b"), "three", "beta", dir);
  await publishPost(author("b"), "no topic here", undefined, dir);

  // Untopicked posts are invisible here; counts and latestAt are per topic.
  assert.deepEqual(await listTopics({ directory: dir }), {
    topics: [
      { name: "alpha", count: 2, latestAt: a2.createdAt },
      { name: "beta", count: 1, latestAt: b1.createdAt },
    ],
  });

  // Literal, case-insensitive name search.
  assert.deepEqual(
    (await listTopics({ directory: dir, query: "ALP" })).topics.map(
      (t) => t.name,
    ),
    ["alpha"],
  );

  // Alphabetic pagination with an exclusive name cursor.
  const page = await listTopics({ directory: dir, limit: 1 });
  assert.deepEqual(page.topics, [
    { name: "alpha", count: 2, latestAt: a2.createdAt },
  ]);
  assert.equal(page.nextCursor, "alpha");
  const rest = await listTopics({
    directory: dir,
    limit: 1,
    before: page.nextCursor,
  });
  assert.deepEqual(rest.topics, [
    { name: "beta", count: 1, latestAt: b1.createdAt },
  ]);
  assert.equal(rest.nextCursor, undefined);

  // A cursor past the end yields an empty page.
  assert.deepEqual(await listTopics({ directory: dir, before: "zzz" }), {
    topics: [],
  });

  // Expired posts leave no topic behind: an already-expired "vanish" post
  // is excluded from aggregation, so its topic disappears entirely.
  handWritePost(dir, Date.now() - DAY_MS, {
    body: "already expired",
    topic: "vanish",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    uuid: "00000000-0000-4000-8000-000000000030",
  });
  assert.deepEqual(
    (await listTopics({ directory: dir })).topics.map((topic) => topic.name),
    ["alpha", "beta"],
  );
});
