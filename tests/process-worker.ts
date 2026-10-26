import { createInterface } from "node:readline";
import { SessionTransport } from "../transport.ts";
import { publishPost, readPosts } from "../board-store.ts";
const [directory, name] = process.argv.slice(2);
const bus = await SessionTransport.start({
  directory,
  info: () => ({
    sessionId: name,
    name,
    cwd: directory,
    pid: process.pid,
    state: "idle",
  }),
  receive: (message) => {
    process.stdout.write(JSON.stringify({ event: "message", message }) + "\n");
  },
});
process.stdout.write(
  JSON.stringify({ event: "ready", id: bus.id, pid: process.pid }) + "\n",
);
const input = createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    const req = JSON.parse(line);
    try {
      let result: unknown;
      if (req.op === "list") result = await bus.list();
      else if (req.op === "send") result = await bus.send(req.to, req.body);
      else if (req.op === "publish")
        result = await publishPost(
          { sessionId: name, name, cwd: directory },
          req.body,
          req.topic,
          req.board,
        );
      else if (req.op === "read")
        result = await readPosts({
          directory: req.board,
          topic: req.topic,
          before: req.before,
          limit: req.limit,
        });
      else throw new Error("Unknown test command");
      process.stdout.write(JSON.stringify({ id: req.id, result }) + "\n");
    } catch (error) {
      process.stdout.write(
        JSON.stringify({ id: req.id, error: String(error) }) + "\n",
      );
    }
  }
} finally {
  await bus.close();
}
