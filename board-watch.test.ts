import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  publishPost,
  type BoardAuthor,
  type BoardPost,
} from "./board-store.ts";
import { BoardWatcher, type BoardWatch } from "./board-watch.ts";

/**
 * Integration tests for BoardWatcher against the real board store: real
 * publishes, real fs events, and the manager's own batching/reconciliation.
 * Deterministic refresh() for negatives and multi-delivery positives; the
 * first test also awaits a delivery purely through the fs event path. No
 * sleeps: fs events only need the watcher to exist first, and refresh() is
 * the deterministic reconciliation hook for everything else.
 */

const SELF = "watcher-self";

const selfAuthor = (name = "watcher"): BoardAuthor => ({
  sessionId: SELF,
  name,
  cwd: "/work/watcher",
});

const peer = (name: string): BoardAuthor => ({
  sessionId: `peer-${name}`,
  name,
  cwd: `/work/${name}`,
});

/** Fresh per-test board directory (mode 0700, owned by us), removed after. */
function makeDir(t: test.TestContext, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `board-watch-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Creates a live watcher plus a recorder for deliveries and errors. */
function makeWatcher(t: test.TestContext, dir: string) {
  const delivered: BoardPost[] = [];
  const batchSizes: number[] = [];
  const errors: Error[] = [];
  const firstDelivery = Promise.withResolvers<BoardPost>();
  const firstError = Promise.withResolvers<Error>();
  let failed = false;
  const watcherPromise = BoardWatcher.create({
    sessionId: SELF,
    directory: dir,
    deliver: (posts) => {
      assert.ok(
        posts.length > 0,
        "deliver must never be called with an empty batch",
      );
      batchSizes.push(posts.length);
      delivered.push(...posts);
      firstDelivery.resolve(posts[posts.length - 1]);
    },
    onError: (error) => {
      if (!failed) {
        failed = true;
        firstError.resolve(error);
      }
      errors.push(error);
    },
  });
  return {
    watcherPromise,
    delivered,
    batchSizes,
    errors,
    /** Resolves with the first delivered post (from any batch). */
    first: firstDelivery.promise,
    /** Resolves with the first error reported through onError. */
    firstError: firstError.promise,
  };
}

/** Board id shape, used to hand-craft a sabotage file in the failure test. */
const boardFileId = (stampMs: number): string =>
  `${String(stampMs).padStart(15, "0")}-00000000-0000-4000-8000-000000000000`;

test(
  "fs events deliver new matching peer posts; historical, own, and off-topic posts are excluded; batches stay bounded",
  { timeout: 10_000 },
  async (t) => {
    const dir = makeDir(t, "events");
    // Historical posts: one matching, one from self, one on another topic.
    await publishPost(peer("ada"), "old news", "general", dir);
    await publishPost(selfAuthor(), "old self post", "general", dir);
    await publishPost(peer("ada"), "old other topic", "random", dir);

    const recorder = makeWatcher(t, dir);
    const watcher = await recorder.watcherPromise;
    t.after(() => watcher.close());
    const watch = await watcher.add({ from: "board:general" });
    assert.ok(watch.id, "add returns a watch id");
    assert.equal(watch.from, "board:general");
    assert.ok(watch.createdAt, "add stamps createdAt");
    assert.equal(watch.expiresAt, undefined, "no ttl means no expiresAt");

    // Own post after registration: fs event fires, but self must never deliver.
    await publishPost(selfAuthor(), "new self post", "general", dir);
    // Publish AFTER registration; no refresh() call — the real fs event path
    // (200 ms batching) must pick this up on its own.
    const fresh = await publishPost(peer("ada"), "fresh news", "general", dir);
    const first = await recorder.first;
    assert.equal(first.id, fresh.id);
    assert.equal(first.body, "fresh news");
    assert.equal(first.topic, "general");

    // A burst of more matching posts, swept by the deterministic hook.
    const burst: string[] = [];
    for (let i = 0; i < 24; i++) {
      const post = await publishPost(peer("ada"), `burst ${i}`, "general", dir);
      burst.push(post.id);
    }
    await watcher.refresh();

    const expected = new Set([fresh.id, ...burst]);
    assert.deepEqual(
      new Set(recorder.delivered.map((post) => post.id)),
      expected,
      "exactly the 25 new matching posts are delivered",
    );
    assert.ok(
      recorder.delivered.every((post) => post.author.sessionId !== SELF),
      "own posts must never be delivered",
    );
    assert.ok(
      recorder.delivered.every((post) => post.topic === "general"),
      "posts on other topics must not be delivered",
    );
    assert.ok(
      recorder.batchSizes.every((size) => size <= 20),
      "every delivered batch is bounded to 20 posts",
    );
    watcher.close();
  },
);

test(
  "author, topic, and grep intersect as an AND; grep is a case-insensitive literal over body, topic, and author name; author matches name or session id",
  { timeout: 5000 },
  async (t) => {
    const dir = makeDir(t, "filters");
    const recorder = makeWatcher(t, dir);
    const watcher = await recorder.watcherPromise;
    t.after(() => watcher.close());
    const andWatch = await watcher.add({
      from: "board:general",
      author: "ada",
      grep: "deploy",
    });
    const grepWatch = await watcher.add({ from: "board:all", grep: "SCRIBE" });
    const idWatch = await watcher.add({
      from: "board:alerts",
      author: "peer-sam",
    });

    // Each miss fails at least one condition of every watch.
    await publishPost(peer("bob"), "deploy failed", "general", dir); // author mismatch for andWatch
    await publishPost(peer("ada"), "unrelated chatter", "general", dir); // grep mismatch for andWatch
    await publishPost(peer("sam"), "alarm", "general", dir); // topic mismatch for idWatch
    await watcher.refresh();
    assert.equal(recorder.delivered.length, 0, "no partial match may deliver");

    const bodyHit = await publishPost(
      peer("ada"),
      "Deploy Complete",
      "general",
      dir,
    );
    const nameHit = await publishPost(
      peer("code-scribe"),
      "plain text",
      "general",
      dir,
    );
    const topicHit = await publishPost(
      peer("bob"),
      "welcome",
      "scribe-lounge",
      dir,
    );
    const idHit = await publishPost(peer("sam"), "alarm", "alerts", dir);
    await watcher.refresh();

    assert.equal(
      recorder.delivered.length,
      4,
      "each hit is delivered exactly once",
    );
    assert.deepEqual(
      new Set(recorder.delivered.map((post) => post.id)),
      new Set([bodyHit.id, nameHit.id, topicHit.id, idHit.id]),
    );
    assert.equal(andWatch.from, "board:general");
    assert.equal(andWatch.grep, "deploy");
    assert.equal(andWatch.author, "ada");
    watcher.close();
  },
);

test(
  "overlapping watches deliver a post exactly once",
  { timeout: 5000 },
  async (t) => {
    const dir = makeDir(t, "overlap");
    const recorder = makeWatcher(t, dir);
    const watcher = await recorder.watcherPromise;
    t.after(() => watcher.close());
    await watcher.add({ from: "board:general", grep: "deploy" });
    await watcher.add({ from: "board:all", author: "ada" });

    const hit = await publishPost(
      peer("ada"),
      "deploy finished",
      "general",
      dir,
    );
    await watcher.refresh();
    await watcher.refresh();
    assert.equal(
      recorder.delivered.length,
      1,
      "two matching watches, one delivery",
    );
    assert.equal(recorder.delivered[0]?.id, hit.id);

    // Off-topic for one watch, wrong author for the other: no delivery.
    await publishPost(peer("bob"), "deploy failed", "random", dir);
    await watcher.refresh();
    assert.equal(
      recorder.delivered.length,
      1,
      "non-matching post adds no delivery",
    );
    watcher.close();
  },
);

test(
  "remove stops one watch while others continue; close stops everything",
  { timeout: 5000 },
  async (t) => {
    const dir = makeDir(t, "lifecycle");
    const recorder = makeWatcher(t, dir);
    const watcher = await recorder.watcherPromise;
    t.after(() => watcher.close());
    const keep = await watcher.add({ from: "board:general" });
    const stop = await watcher.add({ from: "board:random" });

    assert.equal(watcher.remove(stop.id), true, "remove reports success");
    assert.equal(
      watcher.remove(stop.id),
      false,
      "second remove reports failure",
    );
    assert.deepEqual(
      watcher.list().map((watch: BoardWatch) => watch.id),
      [keep.id],
      "list shows only the remaining watch",
    );

    await publishPost(peer("ada"), "random post", "random", dir);
    await watcher.refresh();
    assert.equal(
      recorder.delivered.length,
      0,
      "removed watch must not deliver",
    );

    const kept = await publishPost(peer("ada"), "general post", "general", dir);
    await watcher.refresh();
    assert.equal(recorder.delivered.length, 1, "remaining watch keeps working");
    assert.equal(recorder.delivered[0]?.id, kept.id);

    watcher.close();
    assert.deepEqual(watcher.list(), [], "close clears watches");

    await publishPost(peer("ada"), "after close", "general", dir);
    await watcher.refresh();
    assert.equal(
      recorder.delivered.length,
      1,
      "closed watcher delivers nothing",
    );

    await assert.rejects(
      watcher.add({ from: "board:general" }),
      /closed/i,
      "add after close rejects",
    );
  },
);

test(
  "optional ttl expires the watch; expired watches deliver nothing and are pruned",
  { timeout: 5000 },
  async (t) => {
    const dir = makeDir(t, "ttl");
    const recorder = makeWatcher(t, dir);
    const watcher = await recorder.watcherPromise;
    t.after(() => watcher.close());

    const forever = await watcher.add({ from: "board:general" });
    assert.equal(forever.expiresAt, undefined, "no ttl means no expiresAt");
    const short = await watcher.add({ from: "board:general", ttl: 1 });
    assert.ok(short.expiresAt, "ttl stamps expiresAt");
    const long = await watcher.add({ from: "board:general", ttl: 31_536_000 });
    assert.ok(
      long.expiresAt &&
        Date.parse(long.expiresAt) > Date.now() + 364 * 24 * 3600 * 1000,
      "max ttl expires about a year out",
    );

    const post = await publishPost(
      peer("ada"),
      "before the clock moves",
      "general",
      dir,
    );
    await watcher.refresh();
    assert.equal(
      recorder.delivered.length,
      1,
      "all three watches deliver the post once",
    );

    // Advance only the clock the watcher reads — no sleeps, no real waiting.
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(short.expiresAt) });
    await watcher.refresh();

    assert.deepEqual(
      watcher
        .list()
        .map((watch) => watch.id)
        .sort(),
      [forever.id, long.id].sort(),
      "the expired watch is pruned; the others survive",
    );
    assert.equal(
      recorder.delivered.length,
      1,
      "the expired watch delivered nothing new",
    );
    assert.equal(recorder.delivered[0]?.id, post.id);
  },
);

test(
  "bad filters are rejected and leave no watch behind",
  { timeout: 5000 },
  async (t) => {
    const dir = makeDir(t, "rejects");
    const recorder = makeWatcher(t, dir);
    const watcher = await recorder.watcherPromise;
    t.after(() => watcher.close());

    await assert.rejects(
      watcher.add({ from: "session:general" }),
      /board:/,
      "non-board address rejects",
    );
    await assert.rejects(
      watcher.add({ from: "board:" }),
      /board:/,
      "empty topic rejects",
    );
    await assert.rejects(
      watcher.add({ from: "board:general", grep: "" }),
      /blank/,
      "blank grep rejects",
    );
    await assert.rejects(
      watcher.add({ from: "board:general", grep: "ok", author: "  " }),
      /blank/,
      "blank author rejects",
    );
    await assert.rejects(
      watcher.add({ from: "board:general", author: "a".repeat(257) }),
      /bytes/,
      "oversized author rejects",
    );
    await assert.rejects(
      watcher.add({ from: "board:general", ttl: 0 }),
      /ttl/,
      "zero ttl rejects",
    );
    await assert.rejects(
      watcher.add({ from: "board:general", ttl: 1.5 }),
      /ttl/,
      "fractional ttl rejects",
    );
    await assert.rejects(
      watcher.add({ from: "board:general", ttl: 31_536_001 }),
      /ttl/,
      "oversized ttl rejects",
    );
    assert.deepEqual(watcher.list(), [], "rejected adds leave no watch");

    // Valid adds still work after rejections.
    const good = await watcher.add({
      from: "board:general",
      grep: "ok",
      ttl: 60,
    });
    assert.equal(good.grep, "ok");
    assert.ok(good.expiresAt, "valid ttl is accepted");
    assert.equal(watcher.list().length, 1);
    watcher.close();
  },
);

test(
  "background scan failure stops watches and reports the error",
  { timeout: 5000 },
  async (t) => {
    const dir = makeDir(t, "failures");
    const recorder = makeWatcher(t, dir);
    const watcher = await recorder.watcherPromise;
    t.after(() => watcher.close());
    await watcher.add({ from: "board:general" });

    // A committed-looking post file that is a dangling symlink: the strict
    // reader refuses it, so any scan that reaches it fails.
    const badFile = path.join(dir, `${boardFileId(Date.now() + 10_000)}.json`);
    symlinkSync("/nonexistent-board-target", badFile);

    const error = await recorder.firstError;
    assert.ok(error.message.includes("symlink"));
    assert.deepEqual(
      watcher.list(),
      [],
      "a failed scan stops the manager and clears its watches",
    );
    assert.deepEqual(recorder.errors, [error]);
    await assert.rejects(
      watcher.add({ from: "board:general" }),
      /closed/i,
      "a failed manager rejects new watches",
    );
  },
);
