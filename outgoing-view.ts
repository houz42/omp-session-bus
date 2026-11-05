export type BusRenderResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
};
export interface OutgoingView {
  label: string;
  target: string;
  status: "pending" | "success" | "warning" | "error";
  summary: string;
  body: string;
  error?: string;
  waited?: unknown;
}

/** Only presentation: delivery receipts and addresses are never rewritten. */
export function outgoingView(
  args: Record<string, unknown> | undefined,
  result?: BusRenderResult,
): OutgoingView | undefined {
  if (args?.op !== "send" || args.preview === true) return undefined;
  const target = typeof args.to === "string" ? args.to : "…";
  const body = typeof args.message === "string" ? args.message : "";
  if (!result)
    return { label: "Sending", target, status: "pending", summary: "", body };
  const details =
    result.details && typeof result.details === "object" ? result.details : {};
  const receipts =
    "receipts" in details && Array.isArray(details.receipts)
      ? details.receipts
      : [];
  let accepted = 0;
  let failed = 0;
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object" || !("outcome" in receipt))
      continue;
    if (receipt.outcome === "injected") accepted++;
    else if (receipt.outcome === "failed") failed++;
  }
  const text = result.content.map((part) => part.text).join("\n");
  if (
    target.startsWith("board:") &&
    "post" in details &&
    details.post &&
    !result.isError
  ) {
    return {
      label: "Published",
      target,
      status: "success",
      summary: "stored on board",
      body,
    };
  }
  const isBroadcast = target === "session:all";
  const waited = "waited" in details ? details.waited : undefined;
  if (accepted > 0) {
    return {
      label: isBroadcast ? "Broadcast" : "Sent",
      target,
      status: failed || result.isError ? "warning" : "success",
      summary: isBroadcast
        ? `${accepted} accepted · ${failed} failed/not attempted`
        : `accepted${waited === null ? " · no reply" : ""}`,
      body,
      ...(failed || result.isError ? { error: text } : {}),
      ...(waited ? { waited } : {}),
    };
  }
  if (
    isBroadcast &&
    "recipients" in details &&
    Array.isArray(details.recipients) &&
    details.recipients.length === 0 &&
    !result.isError
  ) {
    return {
      label: "Not sent",
      target,
      status: "warning",
      summary: "no recipients",
      body,
    };
  }
  return {
    label: "Send failed",
    target,
    status: "error",
    summary: "not confirmed",
    body,
    error: text || "Delivery was not confirmed",
  };
}
