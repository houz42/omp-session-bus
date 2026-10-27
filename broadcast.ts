import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  MAX_BODY_BYTES,
  type PeerInfo,
  type SessionTransport,
} from "./transport.ts";

export const BROADCAST_HEADER =
  "Broadcast announcement — no reply expected.\n\n";
export interface BroadcastReceipt {
  to: string;
  outcome: "injected" | "failed";
  attempted: boolean;
  error?: string;
  messageId?: string;
}
export interface BroadcastResult {
  preview: boolean;
  recipients: PeerInfo[];
  messageId?: string;
  receipts: BroadcastReceipt[];
}
export interface BroadcastOptions {
  message?: string;
  preview?: boolean;
  cwd?: string;
  signal?: AbortSignal;
}

/** One fresh roster snapshot; one attempt per peer, never an automatic retry. */
export async function broadcast(
  bus: Pick<SessionTransport, "id" | "list" | "send">,
  options: BroadcastOptions,
): Promise<BroadcastResult> {
  const { message, preview = false, cwd, signal } = options;
  if (typeof preview !== "boolean")
    throw new Error("preview must be a boolean");
  if (cwd !== undefined && (typeof cwd !== "string" || !isAbsolute(cwd)))
    throw new Error("Broadcast cwd must be an exact absolute directory path");
  if (signal?.aborted)
    throw new Error("Broadcast cancelled before discovery; no messages sent");
  let body = "";
  if (!preview || message !== undefined) {
    if (typeof message !== "string" || !message.trim())
      throw new Error("Broadcast message must be nonblank");
    body = BROADCAST_HEADER + message;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES)
      throw new Error(
        `Broadcast message plus its ${Buffer.byteLength(BROADCAST_HEADER)}-byte announcement header must fit ${MAX_BODY_BYTES} UTF-8 bytes`,
      );
  }
  const recipients = (await bus.list(signal)).filter(
    (peer) => peer.id !== bus.id && (cwd === undefined || peer.cwd === cwd),
  );
  if (signal?.aborted)
    throw new Error("Broadcast cancelled during discovery; no messages sent");
  if (preview) return { preview: true, recipients, receipts: [] };

  const messageId = randomUUID();
  const receipts = new Array<BroadcastReceipt>(recipients.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, recipients.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= recipients.length) return;
        const to = recipients[index].id;
        if (signal?.aborted) {
          receipts[index] = {
            to,
            outcome: "failed",
            attempted: false,
            error: "Cancelled before dispatch; not sent",
          };
          continue;
        }
        try {
          await bus.send(to, body, { id: messageId, broadcast: true, signal });
          receipts[index] = {
            to,
            outcome: "injected",
            attempted: true,
            messageId,
          };
        } catch (error) {
          receipts[index] = {
            to,
            outcome: "failed",
            attempted: true,
            messageId,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }),
  );
  return { preview: false, recipients, messageId, receipts };
}
