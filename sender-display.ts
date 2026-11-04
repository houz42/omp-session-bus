import { stripVTControlCharacters } from "node:util";
import type { Envelope } from "./transport.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Display label only. The native IRC renderer clips this to the actual viewport width. */
export function senderLabel(
  message: Pick<Envelope, "from" | "senderTitle" | "broadcast">,
): string {
  const clean = stripVTControlCharacters(message.senderTitle ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Bound the title so long labels cannot crowd the entire address out of the header.
  const parts: string[] = [];
  for (const part of graphemes.segment(clean)) {
    if (parts.length === 40) {
      parts.push("…");
      break;
    }
    parts.push(part.segment);
  }
  const title = parts.join("");
  return `${title ? `${title} · ` : ""}${message.from}${message.broadcast ? " [broadcast]" : ""}`;
}

/** Full, unabridged identity for model context and replies, independent of UI clipping. */
export function senderContext(
  message: Pick<Envelope, "from" | "senderTitle">,
): string {
  return `${message.from}${message.senderTitle?.trim() ? ` (title: ${JSON.stringify(message.senderTitle)})` : ""}`;
}
