import assert from "node:assert/strict";
import { test } from "node:test";
import { senderContext, senderLabel } from "./sender-display.ts";

const from = "session:01234567-89ab-4cde-8f01-23456789abcd";

test("sender title is display-only and never replaces or abbreviates reply identity", () => {
  const message = { from, senderTitle: "Scene Baking", broadcast: true };
  const original = { ...message };
  const label = senderLabel(message);
  assert.ok(label.indexOf("Scene Baking") < label.indexOf(from));
  assert.ok(label.endsWith("[broadcast]"));
  assert.ok(senderContext(message).includes(from));
  assert.deepEqual(message, original);
  assert.equal(senderLabel({ from }), from);
  assert.equal(senderLabel({ from, senderTitle: " \n " }), from);
});

test("header titles cannot inject terminal controls or crowd out the UUID", () => {
  const title =
    "\x1b[31mDanger\x1b[0m\n\x1b]8;;https://example.com\x07Label\x1b]8;;\x07\u202e" +
    "界".repeat(100);
  const message = { from, senderTitle: title };
  const label = senderLabel(message);
  assert.ok(label.includes(from));
  assert.ok(!/[\x00-\x1f\x7f-\x9f\u202a-\u202e]/.test(label));
  assert.ok(label.includes("…"));
  assert.ok(label.length < title.length);
  // Full metadata remains intact; escaped context cannot inject control bytes.
  assert.equal(message.senderTitle, title);
  assert.ok(senderContext(message).includes(JSON.stringify(title)));
});
