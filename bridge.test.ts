import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "./index.ts";
import { SessionTransport, type Envelope } from "./transport.ts";

type API = Parameters<typeof extension>[0];
type Context = Parameters<Parameters<API["on"]>[1]>[1];
type Tool = Parameters<API["registerTool"]>[0];

async function fixture() {
  const directory = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "omp-bridge-"),
  );
  const previous = process.env.OMP_SESSION_BUS_DIR;
  process.env.OMP_SESSION_BUS_DIR = directory;
  const handlers = new Map<string, Parameters<API["on"]>[1]>();
  const injected: Array<Parameters<API["sendMessage"]>[0]> = [];
  let tool: Tool | undefined;
  const context: Context = {
    cwd: directory,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "saved-session" },
    ui: {
      notify: (text) => {
        throw new Error(text);
      },
    },
  };
  extension({
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    getSessionName: () => "bridge",
    registerTool: (registered) => {
      tool = registered;
    },
    registerCommand: () => {},
    sendMessage: (message) => {
      injected.push(message);
    },
  });
  assert.ok(
    tool,
    "Tool must be registered before session_start for launch filtering",
  );
  assert.equal(tool.name, "session_bus");
  await handlers.get("session_start")?.({}, context);
  assert.ok(tool);
  return {
    directory,
    context,
    injected,
    tool,
    handlers,
    async close() {
      await handlers.get("session_shutdown")?.({}, context);
      if (previous === undefined) delete process.env.OMP_SESSION_BUS_DIR;
      else process.env.OMP_SESSION_BUS_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("await accepts the next peer message without replyTo; later messages inject once", async () => {
  const f = await fixture();
  let peer: SessionTransport | undefined;
  try {
    peer = await SessionTransport.start({
      directory: f.directory,
      info: () => ({
        sessionId: "peer",
        name: "peer",
        cwd: f.directory,
        pid: process.pid,
        state: "idle",
      }),
      receive: async (message) => {
        assert.ok(peer);
        await peer.send(message.from, "answer without quoting");
        await peer.send(message.from, "follow-up", { replyTo: message.id });
      },
    });
    const result = await f.tool.execute(
      "send",
      { op: "send", to: peer.id, message: "question", await: true },
      undefined,
      undefined,
      f.context,
    );
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /answer/);
    assert.equal(f.injected.length, 1);
    assert.equal((f.injected[0].details as Envelope).body, "follow-up");
  } finally {
    await peer?.close();
    await f.close();
  }
});

test("cancelling an accepted send releases waiter; late reply becomes an aside", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const accepted = Promise.withResolvers<Envelope>();
  const peer = await SessionTransport.start({
    directory: f.directory,
    info: () => ({
      sessionId: "peer",
      name: "peer",
      cwd: f.directory,
      pid: process.pid,
      state: "idle",
    }),
    receive: (message) => {
      accepted.resolve(message);
    },
  });
  try {
    const result = f.tool.execute(
      "send",
      { op: "send", to: peer.id, message: "question", await: true },
      abort.signal,
      undefined,
      f.context,
    );
    const message = await accepted.promise;
    abort.abort();
    await result;
    await peer.send(message.from, "late answer", { replyTo: message.id });
    assert.equal(f.injected.length, 1);
    assert.equal((f.injected[0].details as Envelope).body, "late answer");
  } finally {
    await peer.close();
    await f.close();
  }
});

test("session discovery is explicit and bare list never substitutes peer discovery", async () => {
  const f = await fixture();
  const peer = await SessionTransport.start({
    directory: f.directory,
    info: () => ({
      sessionId: "separate-session",
      name: "Separate",
      cwd: "/other",
      pid: process.pid,
      state: "idle",
    }),
    receive: () => {},
  });
  try {
    const local = await f.tool.execute(
      "local",
      { op: "list" },
      undefined,
      undefined,
      f.context,
    );
    assert.equal(local.isError, true);
    const remote = await f.tool.execute(
      "remote",
      { op: "sessions" },
      undefined,
      undefined,
      f.context,
    );
    assert.ok(remote.content.some((part) => part.text.includes(peer.id)));
  } finally {
    await peer.close();
    await f.close();
  }
});

test("standalone tool delivers without exposing native operations", async () => {
  const f = await fixture();
  const messages: Envelope[] = [];
  const peer = await SessionTransport.start({
    directory: f.directory,
    info: () => ({
      sessionId: "peer",
      name: "Peer",
      cwd: "/other",
      pid: process.pid,
      state: "idle",
    }),
    receive: (message) => {
      messages.push(message);
    },
  });
  try {
    const unsupported = await f.tool.execute(
      "native",
      { op: "list" },
      undefined,
      undefined,
      f.context,
    );
    assert.equal(unsupported.isError, true);
    const sent = await f.tool.execute(
      "send",
      { op: "send", to: peer.id, message: "Modern host message" },
      undefined,
      undefined,
      f.context,
    );
    assert.equal(sent.isError, undefined);
    assert.equal(messages[0]?.body, "Modern host message");
    const discovery = await f.tool.execute(
      "discover",
      { op: "sessions" },
      undefined,
      undefined,
      f.context,
    );
    assert.ok(discovery.content.some((part) => part.text.includes(peer.id)));
  } finally {
    await peer.close();
    await f.close();
  }
});

test("board subscriptions end on session switch and old watch ids cannot cancel new subscriptions", async () => {
  const f = await fixture();
  const previous = process.env.OMP_SESSION_BOARD_DIR;
  process.env.OMP_SESSION_BOARD_DIR = join(f.directory, "board");
  try {
    const first = await f.tool.execute(
      "watch",
      { op: "watch", from: "board:updates" },
      undefined,
      undefined,
      f.context,
    );
    assert.equal(first.isError, undefined);
    assert.ok(
      first.details &&
        typeof first.details === "object" &&
        "watch" in first.details,
    );
    const firstWatch = first.details.watch;
    assert.ok(
      firstWatch &&
        typeof firstWatch === "object" &&
        "id" in firstWatch &&
        typeof firstWatch.id === "string",
    );
    const oldId = firstWatch.id;
    await f.handlers.get("session_switch")?.({}, f.context);
    const cleared = await f.tool.execute(
      "list",
      { op: "watches" },
      undefined,
      undefined,
      f.context,
    );
    assert.deepEqual(cleared.details, { watches: [] });
    const second = await f.tool.execute(
      "new",
      { op: "watch", from: "board:updates" },
      undefined,
      undefined,
      f.context,
    );
    assert.equal(second.isError, undefined);
    const stale = await f.tool.execute(
      "remove",
      { op: "unwatch", id: oldId },
      undefined,
      undefined,
      f.context,
    );
    assert.equal(stale.isError, true);
    const active = await f.tool.execute(
      "active",
      { op: "watches" },
      undefined,
      undefined,
      f.context,
    );
    assert.ok(
      second.details &&
        typeof second.details === "object" &&
        "watch" in second.details,
    );
    assert.deepEqual(active.details, { watches: [second.details.watch] });
  } finally {
    if (previous === undefined) delete process.env.OMP_SESSION_BOARD_DIR;
    else process.env.OMP_SESSION_BOARD_DIR = previous;
    await f.close();
  }
});
