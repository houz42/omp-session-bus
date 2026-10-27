import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import test from "node:test";
import { broadcast, BROADCAST_HEADER } from "./broadcast.ts";
import { MAX_BODY_BYTES, SessionTransport } from "./transport.ts";
import type { Envelope, PeerInfo } from "./transport.ts";

/** Resolves with the next delivered envelope, arrived or not — no sleeps. */
class Mailbox {
  readonly log: Envelope[] = [];
  private cursor = 0;
  private waiters: Array<(m: Envelope) => void> = [];
  onReceive: (() => void | Promise<void>) | null = null;
  failWith: Error | null = null;

  readonly receive = async (message: Envelope): Promise<void> => {
    this.log.push(message);
    if (this.failWith) throw this.failWith;
    await this.onReceive?.();
  };

  async next(): Promise<Envelope> {
    const i = this.cursor++;
    if (i < this.log.length) return this.log[i];
    const { promise, resolve } = Promise.withResolvers<Envelope>();
    this.waiters.push(resolve);
    return promise;
  }
}

/** Fresh per-test bus directory; every started transport is closed after. */
function makeWorld(t: test.TestContext, label: string) {
  const dir = mkdtempSync(
    path.join(
      process.platform === "darwin" ? "/tmp" : tmpdir(),
      `sb-broadcast-${label}-`,
    ),
  );
  const started: SessionTransport[] = [];
  const spawn = async (name: string, cwd: string, box = new Mailbox()) => {
    const transport = await SessionTransport.start({
      directory: dir,
      info: (): Omit<PeerInfo, "id"> => ({
        sessionId: `sess-${name}`,
        name,
        cwd,
        pid: process.pid,
        state: "idle" as const,
      }),
      receive: box.receive,
    });
    started.push(transport);
    return { transport, box };
  };
  t.after(async () => {
    for (const tr of started) await tr.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, spawn };
}

test("preview is read-only: lists recipients excluding self, sends nothing, and may omit the message", async (t) => {
  const { spawn } = makeWorld(t, "preview");
  const sender = await spawn("sender", "/work/sender");
  const a = await spawn("alpha", "/work/alpha");
  const b = await spawn("bravo", "/work/bravo");

  const result = await broadcast(sender.transport, { preview: true });
  assert.equal(result.preview, true);
  assert.deepEqual(
    result.recipients.map((p) => p.id).sort(),
    [a.transport.id, b.transport.id].sort(),
  );
  assert.deepEqual(result.receipts, []);
  assert.equal(result.messageId, undefined);
  // Read-only: nothing was delivered anywhere, including to the sender itself.
  assert.equal(a.box.log.length, 0);
  assert.equal(b.box.log.length, 0);
  assert.equal((sender.box as Mailbox).log.length, 0);
});

test("broadcast delivers to every peer except the sender with one shared id, a broadcast flag, and the announcement header; invalid input is rejected before any send", async (t) => {
  const { spawn } = makeWorld(t, "deliver");
  const sender = await spawn("sender", "/work/sender");
  const a = await spawn("alpha", "/work/alpha");
  const b = await spawn("bravo", "/work/bravo");

  const result = await broadcast(sender.transport, {
    message: "hello team",
  });
  assert.equal(result.preview, false);
  const delivered = await Promise.all([a.box.next(), b.box.next()]);
  for (const envelope of delivered) {
    assert.equal(envelope.id, result.messageId);
    assert.equal(envelope.broadcast, true);
    assert.equal(envelope.from, sender.transport.id);
    assert.equal(envelope.body, BROADCAST_HEADER + "hello team");
  }
  assert.deepEqual(
    result.receipts.map((r) => r.to).sort(),
    [a.transport.id, b.transport.id].sort(),
  );
  for (const receipt of result.receipts) {
    assert.equal(receipt.outcome, "injected");
    assert.equal(receipt.attempted, true);
    assert.equal(receipt.messageId, result.messageId);
  }
  assert.equal((sender.box as Mailbox).log.length, 0);

  // Invalid payloads and a relative cwd reject before discovery can send anything.
  for (const options of [
    { message: "   " },
    { message: "x".repeat(MAX_BODY_BYTES) },
    { message: "hi", cwd: "work/alpha" },
    {},
  ] as const) {
    await assert.rejects(broadcast(sender.transport, { ...options }));
  }
  assert.equal(a.box.log.length, 1);
  assert.equal(b.box.log.length, 1);
});

test("cwd filter matches the exact directory only — a child path is not a match", async (t) => {
  const { spawn } = makeWorld(t, "cwd");
  const sender = await spawn("sender", "/work/sender");
  const inside = await spawn("inside", "/work/project");
  const child = await spawn("child", "/work/project/sub");
  const outside = await spawn("outside", "/work/elsewhere");

  const result = await broadcast(sender.transport, {
    message: "scoped",
    cwd: "/work/project",
  });
  assert.deepEqual(
    result.recipients.map((p) => p.id),
    [inside.transport.id],
  );
  assert.deepEqual(
    result.receipts.map((r) => r.to),
    [inside.transport.id],
  );
  assert.equal(inside.box.log.length, 1);
  assert.equal((child.box as Mailbox).log.length, 0);
  assert.equal((outside.box as Mailbox).log.length, 0);
  assert.equal((sender.box as Mailbox).log.length, 0);
});

test("a failing recipient is isolated, and cancellation before or during delivery yields full receipts with no retries", async (t) => {
  const { spawn } = makeWorld(t, "cancel");
  const sender = await spawn("sender", "/work/sender");
  const good = await spawn("good", "/work/good");
  const bad = await spawn("bad", "/work/bad");
  bad.box.failWith = new Error("refused");

  // One recipient's rejection never blocks or fails its siblings.
  const isolated = await broadcast(sender.transport, { message: "one bad" });
  const byTo = new Map(isolated.receipts.map((r) => [r.to, r]));
  assert.equal(byTo.get(good.transport.id)?.outcome, "injected");
  const badReceipt = byTo.get(bad.transport.id);
  assert.equal(badReceipt?.outcome, "failed");
  assert.equal(badReceipt?.attempted, true);
  assert.match(badReceipt?.error ?? "", /refused/);
  assert.equal(good.box.log.length, 1);
  bad.box.failWith = null;

  // Cancelled before discovery: rejects, nothing sent.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    broadcast(sender.transport, {
      message: "never",
      signal: controller.signal,
    }),
  );
  assert.equal(good.box.log.length, 1);
  assert.equal(bad.box.log.length, 1);

  // Cancelled during delivery: resolves with a receipt for every recipient,
  // and no recipient is ever delivered twice (no retries).
  const late = new AbortController();
  bad.box.onReceive = () => {
    late.abort();
  };
  const cancelled = await broadcast(sender.transport, {
    message: "abort mid-flight",
    signal: late.signal,
  });
  assert.equal(cancelled.receipts.length, 2);
  for (const receipt of cancelled.receipts) {
    assert.ok(receipt.outcome === "injected" || receipt.outcome === "failed");
    if (receipt.outcome === "failed" && !receipt.attempted)
      assert.ok(receipt.error);
  }
  // The sibling send may have already injected or been aborted mid-flight.
  assert.ok(good.box.log.length >= 1 && good.box.log.length <= 2);
  assert.ok(bad.box.log.length >= 1 && bad.box.log.length <= 2);
});

test("the recipient snapshot is fresh per call: a peer spawned inside a receive callback is not sent to", async (t) => {
  const { spawn } = makeWorld(t, "snapshot");
  const sender = await spawn("sender", "/work/sender");
  const a = await spawn("alpha", "/work/alpha");
  let spawnedLate: { transport: SessionTransport; box: Mailbox } | undefined;
  a.box.onReceive = async () => {
    if (!spawnedLate) spawnedLate = await spawn("late", "/work/late");
  };

  const result = await broadcast(sender.transport, { message: "snapshot" });
  assert.deepEqual(
    result.recipients.map((p) => p.id),
    [a.transport.id],
  );
  assert.deepEqual(
    result.receipts.map((r) => r.to),
    [a.transport.id],
  );
  await a.box.next();
  assert.ok(spawnedLate);
  // The late peer's endpoint is live but was never part of the snapshot.
  assert.equal(spawnedLate.box.log.length, 0);
});

test(
  "cancellation leaves unscheduled recipients explicitly unattempted",
  { timeout: 10000 },
  async (t) => {
    const { spawn } = makeWorld(t, "bounded");
    const sender = await spawn("sender", "/work");
    const controller = new AbortController();
    const peers = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const peer = await spawn(`peer-${i}`, "/work");
        peer.box.onReceive = () => {
          controller.abort();
        };
        return peer;
      }),
    );
    const result = await broadcast(sender.transport, {
      message: "cancel bounded wave",
      signal: controller.signal,
    });
    assert.equal(result.receipts.length, 12);
    assert.equal(
      new Set(result.receipts.map((receipt) => receipt.to)).size,
      12,
    );
    assert.ok(
      result.receipts.filter((receipt) => !receipt.attempted).length >= 4,
    );
    for (const receipt of result.receipts.filter(
      (receipt) => !receipt.attempted,
    )) {
      const peer = peers.find((peer) => peer.transport.id === receipt.to);
      assert.equal(peer?.box.log.length, 0);
    }
    assert.ok(peers.every((peer) => peer.box.log.length <= 1));
  },
);
