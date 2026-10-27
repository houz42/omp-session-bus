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

async function fixture(nativeHub = true) {
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
    invokeTool: async () => ({ content: [{ type: "text", text: "native" }] }),
  };
  extension({
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    getAllTools: () =>
      nativeHub
        ? [
            {
              name: "hub",
              description: "native",
              parameters: {},
              sourceInfo: { source: "builtin" },
            },
          ]
        : [],
    getSessionName: () => "bridge",
    registerTool: (registered) => {
      tool = registered;
    },
    registerCommand: () => {},
    sendMessage: (message) => {
      injected.push(message);
    },
  });
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

test("native list stays local while sessions explicitly discovers cross-session peers", async () => {
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
    assert.equal(local.content.map((part) => part.text).join("\n"), "native");
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

test("host without native hub supports cross-session delivery without emulating native operations", async () => {
  const f = await fixture(false);
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
