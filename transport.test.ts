import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import test from "node:test";
import { MAX_BODY_BYTES, SessionTransport } from "./transport.ts";
import type { Envelope, PeerInfo } from "./transport.ts";

/**
 * Collects envelopes handed to a peer's receive callback. `next()` resolves
 * deterministically with the next delivered message (already arrived or not),
 * so tests never sleep. `failWith` makes the callback reject, modeling a
 * receiver that refuses a message.
 */
class Mailbox {
  readonly log: Envelope[] = [];
  private cursor = 0;
  private waiters: Array<(m: Envelope) => void> = [];
  failWith: Error | null = null;

  readonly receive = async (message: Envelope): Promise<void> => {
    this.log.push(message);
    if (this.failWith) throw this.failWith;
    this.waiters.shift()?.(message);
  };

  next(): Promise<Envelope> {
    const i = this.cursor++;
    if (i < this.log.length) return Promise.resolve(this.log[i]);
    const { promise, resolve } = Promise.withResolvers<Envelope>();
    this.waiters.push(resolve);
    return promise;
  }
}

function peerOptions(
  directory: string,
  name: string,
  receive: (m: Envelope) => void | Promise<void>,
) {
  return {
    directory,
    info: (): Omit<PeerInfo, "id"> => ({
      sessionId: `sess-${name}`,
      name,
      cwd: `/work/${name}`,
      pid: process.pid,
      state: "idle" as const,
    }),
    receive,
  };
}

/** Fresh per-test bus directory; every started transport is closed after. */
function makeWorld(t: test.TestContext, label: string) {
  const dir = mkdtempSync(
    path.join(
      process.platform === "darwin" ? "/tmp" : tmpdir(),
      `omp-session-bus-${label}-`,
    ),
  );
  const started: SessionTransport[] = [];
  const spawn = async (name: string, box = new Mailbox()) => {
    const transport = await SessionTransport.start(
      peerOptions(dir, name, box.receive),
    );
    started.push(transport);
    return { transport, box };
  };
  t.after(async () => {
    for (const tr of started) await tr.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, spawn, started };
}

/** Contract: sockets are named <uuid>.sock and ids are "session:"+uuid. */
const socketPath = (t: SessionTransport) =>
  path.join(t.directory, t.id.slice("session:".length) + ".sock");

/**
 * Sends one raw NDJSON request line over a private connection to the peer and
 * resolves with the reply lines the peer wrote back before closing.
 */
async function exchangeRawLine(
  peerSocket: string,
  line: string,
): Promise<string[]> {
  const socket = net.createConnection(peerSocket);
  const { promise, resolve } = Promise.withResolvers<string[]>();
  let buffered = "";
  socket.on("connect", () => {
    socket.write(line);
    socket.end();
  });
  socket.on("data", (chunk) => {
    buffered += chunk;
  });
  socket.on("close", () =>
    resolve(buffered.split("\n").filter((l) => l.length > 0)),
  );
  return promise;
}

test("list discovers live peers with fresh info and ignores unreachable endpoints", async (t) => {
  const { dir, spawn, started } = makeWorld(t, "discovery");
  const a = await spawn("alpha");
  let info: Omit<PeerInfo, "id"> = {
    sessionId: "sess-bravo",
    name: "bravo",
    cwd: "/work/bravo",
    pid: process.pid,
    state: "idle",
  };
  const b = {
    transport: await SessionTransport.start({
      directory: dir,
      info: () => info,
      receive: () => {},
    }),
  };
  started.push(b.transport);
  // A stale non-socket file squatting on a socket name must never surface as a peer.
  writeFileSync(
    path.join(dir, "9f0c0d6e-0000-4000-8000-000000000000.sock"),
    "not a socket",
  );

  const peers = await a.transport.list();
  assert.deepEqual(
    peers.map((p) => p.id).sort(),
    [a.transport.id, b.transport.id].sort(),
  );

  const bravo = peers.find((p) => p.id === b.transport.id);
  assert.ok(bravo, "peer endpoint missing from list");
  assert.equal(bravo.name, "bravo");
  assert.equal(bravo.sessionId, "sess-bravo");
  assert.equal(bravo.cwd, "/work/bravo");
  assert.equal(bravo.pid, process.pid);
  assert.equal(bravo.state, "idle");
  info = { ...info, name: "renamed", state: "running", cwd: "/work/new" };
  const updated = (await a.transport.list()).find(
    (p) => p.id === b.transport.id,
  );
  assert.equal(updated?.name, "renamed");
  assert.equal(updated?.state, "running");
  assert.equal(updated?.cwd, "/work/new");
});

test("send delivers to the live peer; replies flow back with replyTo", async (t) => {
  const { spawn } = makeWorld(t, "delivery");
  const a = await spawn("alpha");
  const b = await spawn("bravo");

  const sent = await a.transport.send(b.transport.id, "ping", { id: "msg-1" });
  assert.equal(sent.id, "msg-1");
  assert.equal(sent.from, a.transport.id);
  assert.equal(sent.to, b.transport.id);
  assert.equal(sent.body, "ping");
  assert.ok(Number.isFinite(sent.ts));
  assert.deepEqual(await b.box.next(), sent);

  const reply = await b.transport.send(a.transport.id, "pong", {
    replyTo: "msg-1",
  });
  assert.equal(reply.replyTo, "msg-1");
  assert.deepEqual(await a.box.next(), reply);
});

test("a rejecting receive callback rejects send; the peer then recovers", async (t) => {
  const { spawn } = makeWorld(t, "refusal");
  const a = await spawn("alpha");
  const b = await spawn("bravo");

  b.box.failWith = new Error("callback refused the message");
  await assert.rejects(a.transport.send(b.transport.id, "poison"));

  b.box.failWith = null;
  const ok = await a.transport.send(b.transport.id, "remedy");
  assert.equal(ok.body, "remedy");
  assert.equal(b.box.log.at(-1)?.body, "remedy");
});

test("garbage and oversized frames cannot deliver, and the peer stays healthy", async (t) => {
  const { spawn } = makeWorld(t, "frames");
  const a = await spawn("alpha");
  const b = await spawn("bravo");
  const bSocket = socketPath(b.transport);

  // One connection per frame: the wire is one request, one reply, half-close.
  const garbageReplies = await exchangeRawLine(bSocket, "this is not json\n");
  const oversizedReplies = await exchangeRawLine(
    bSocket,
    JSON.stringify({
      type: "send",
      message: {
        id: "raw-1",
        from: a.transport.id,
        to: b.transport.id,
        body: "x".repeat(MAX_BODY_BYTES + 1),
        ts: Date.now(),
      },
    }) + "\n",
  );
  for (const replies of [garbageReplies, oversizedReplies]) {
    for (const line of replies) {
      const reply = JSON.parse(line) as { ok?: boolean };
      assert.equal(
        reply.ok,
        false,
        "a bad frame must never be acknowledged as success",
      );
    }
  }

  // The healthy send opens its own connection and must succeed regardless.
  const sent = await a.transport.send(b.transport.id, "still-here");
  assert.equal(sent.body, "still-here");
  assert.equal(
    b.box.log.length,
    1,
    "only the healthy message may be delivered",
  );
  assert.equal(b.box.log[0]?.body, "still-here");

  // Oversized bodies are refused before delivery even via the public API.
  await assert.rejects(
    a.transport.send(b.transport.id, "x".repeat(MAX_BODY_BYTES + 1)),
  );
  assert.equal(b.box.log.length, 1);
});

test("self-send, unknown recipient, and aborted sends all reject without delivery", async (t) => {
  const { spawn } = makeWorld(t, "invalid");
  const a = await spawn("alpha");
  const b = await spawn("bravo");

  await assert.rejects(a.transport.send(a.transport.id, "to-self"));
  await assert.rejects(
    a.transport.send(
      "session:ffffffff-ffff-4fff-8fff-ffffffffffff",
      "to-ghost",
    ),
  );

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    a.transport.send(b.transport.id, "aborted", { signal: ac.signal }),
  );
  assert.equal(b.box.log.length, 0);
});

test("close is idempotent, isolates the endpoint, and preserves other endpoints", async (t) => {
  const { spawn } = makeWorld(t, "close");
  const a = await spawn("alpha");
  const b = await spawn("bravo");
  await a.transport.send(b.transport.id, "before");

  const bravoSocket = socketPath(b.transport);
  await a.transport.close();
  await a.transport.close();
  await assert.rejects(a.transport.send(b.transport.id, "after-close"));
  await assert.rejects(a.transport.list());

  const peers = await b.transport.list();
  assert.deepEqual(
    peers.map((p) => p.id),
    [b.transport.id],
  );
  assert.ok(
    existsSync(bravoSocket),
    "closing one endpoint must not unlink another endpoint",
  );

  const c = await spawn("charlie");
  const delivered = await c.transport.send(b.transport.id, "still-alive");
  assert.equal(delivered.body, "still-alive");
  assert.equal(b.box.log.at(-1)?.body, "still-alive");
});

test("start rejects unsafe directories", async (t) => {
  const noop = new Mailbox();
  const loose = mkdtempSync(path.join(tmpdir(), "omp-session-bus-loose-"));
  chmodSync(loose, 0o777);
  const real = mkdtempSync(path.join(tmpdir(), "omp-session-bus-real-"));
  const link = `${real}-link`;
  symlinkSync(real, link);
  t.after(() => {
    rmSync(loose, { recursive: true, force: true });
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  });

  await assert.rejects(
    SessionTransport.start(peerOptions(loose, "loose", noop.receive)),
  );
  await assert.rejects(
    SessionTransport.start(peerOptions(link, "linked", noop.receive)),
  );
});

test("oversized socket paths fail clearly without binding a truncated endpoint", async (t) => {
  const { dir } = makeWorld(t, "path-limit");
  const longDirectory = path.join(dir, "x".repeat(110));
  await assert.rejects(
    SessionTransport.start(peerOptions(longDirectory, "long", () => {})),
    /OMP_SESSION_BUS_DIR/,
  );
});
