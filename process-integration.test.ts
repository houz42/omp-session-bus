import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

type Frame = {
  id?: string;
  event?: string;
  pid?: number;
  result?: unknown;
  error?: string;
  message?: { body: string; from: string };
};
function worker(directory: string, name: string) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("./tests/process-worker.ts", import.meta.url)),
      directory,
      name,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const frames: Frame[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const frame = JSON.parse(line) as Frame;
    frames.push(frame);
    for (const listener of listeners) listener(frame);
  });
  const exit = Promise.withResolvers<void>();
  const exited = exit.promise;
  child.on("error", exit.reject);
  child.on("exit", (code) =>
    code === 0
      ? exit.resolve()
      : exit.reject(new Error(`${name} exited ${code}: ${stderr}`)),
  );
  void exited.catch(() => {});
  let seq = 0;
  function wait(predicate: (frame: Frame) => boolean): Promise<Frame> {
    const existing = frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    const pending = Promise.withResolvers<Frame>();
    // Deadlines bound failed external processes, never gate successful event delivery.
    const timer = setTimeout(() => {
      listeners.delete(listener);
      pending.reject(new Error(`${name}: frame timeout: ${stderr}`));
    }, 10000);
    const listener = (frame: Frame) => {
      if (!predicate(frame)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      pending.resolve(frame);
    };
    listeners.add(listener);
    return pending.promise;
  }
  return {
    ready: wait((frame) => frame.event === "ready"),
    wait,
    async request(params: Record<string, unknown>) {
      const id = String(++seq);
      const response = wait((frame) => frame.id === id);
      child.stdin.write(JSON.stringify({ ...params, id }) + "\n");
      const frame = await response;
      if (frame.error) throw new Error(frame.error);
      return frame.result;
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        lines.close();
      }
    },
  };
}

test(
  "independent processes discover, exchange messages, persist board posts, and retire endpoints",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "bus-process-"));
    const board = join(directory, "board");
    const a = worker(directory, "A");
    const b = worker(directory, "B");
    let closedA = false;
    try {
      const [ar, br] = await Promise.all([a.ready, b.ready]);
      assert.notEqual(ar.pid, br.pid);
      const peers = (await a.request({ op: "list" })) as Array<{ id: string }>;
      assert.deepEqual(peers.map((p) => p.id).sort(), [ar.id, br.id].sort());
      await a.request({ op: "send", to: br.id, body: "A to B" });
      assert.equal(
        (await b.wait((f) => f.event === "message")).message?.body,
        "A to B",
      );
      await b.request({ op: "send", to: ar.id, body: "B to A" });
      assert.equal(
        (await a.wait((f) => f.event === "message")).message?.body,
        "B to A",
      );
      await Promise.all([
        a.request({ op: "publish", board, topic: "shared", body: "A finding" }),
        b.request({ op: "publish", board, topic: "shared", body: "B finding" }),
      ]);
      await a.request({
        op: "publish",
        board,
        topic: "other",
        body: "not shared",
      });
      await a.close();
      closedA = true;
      await assert.rejects(
        b.request({ op: "send", to: ar.id, body: "offline" }),
      );
      const remaining = (await b.request({ op: "list" })) as Array<{
        id: string;
      }>;
      assert.deepEqual(
        remaining.map((p) => p.id),
        [br.id],
      );
      const first = (await b.request({
        op: "read",
        board,
        topic: "shared",
        limit: 1,
      })) as { posts: Array<{ body: string }>; nextCursor: string };
      const second = (await b.request({
        op: "read",
        board,
        topic: "shared",
        limit: 1,
        before: first.nextCursor,
      })) as { posts: Array<{ body: string }>; nextCursor?: string };
      assert.deepEqual(
        [...first.posts, ...second.posts].map((p) => p.body).sort(),
        ["A finding", "B finding"],
      );
      assert.equal(second.nextCursor, undefined);
    } finally {
      await Promise.all([...(closedA ? [] : [a.close()]), b.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
