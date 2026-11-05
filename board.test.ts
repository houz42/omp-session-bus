import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeBoard } from "./board.ts";
import { outgoingView } from "./outgoing-view.ts";

test("board addresses publish without recipients and reads never consume posts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "board-address-"));
  const previous = process.env.OMP_SESSION_BOARD_DIR;
  process.env.OMP_SESSION_BOARD_DIR = directory;
  const author = { sessionId: "author-id", name: "Author", cwd: "/work" };
  try {
    await assert.rejects(
      executeBoard({ op: "send", to: "board:all", message: "wrong" }, author),
    );
    await assert.rejects(
      executeBoard(
        { op: "send", to: "board:general", message: "wrong", await: true },
        author,
      ),
    );
    const args = { op: "send", to: "board:general", message: "Useful finding" };
    const published = await executeBoard(args, author);
    const view = outgoingView(args, published);
    assert.equal(view?.label, "Published");
    assert.equal(view?.status, "success");
    assert.equal(view?.target, "board:general");
    const first = await executeBoard(
      { op: "list", from: "board:general" },
      author,
    );
    const second = await executeBoard(
      { op: "list", from: "board:all", grep: "finding" },
      author,
    );
    assert.deepEqual(first.details.inbox, second.details.inbox);
    assert.equal(first.details.inbox?.length, 1);
    assert.equal(first.details.inbox?.[0].body, "Useful finding");
    await assert.rejects(
      executeBoard({ op: "wait", from: "board:general" }, author),
    );
    await assert.rejects(
      executeBoard({ op: "inbox", from: "board:general" }, author),
    );
    const topics = await executeBoard({ op: "topics", grep: "gen" }, author);
    assert.equal(topics.details.topics?.[0].name, "general");
  } finally {
    if (previous === undefined) delete process.env.OMP_SESSION_BOARD_DIR;
    else process.env.OMP_SESSION_BOARD_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
