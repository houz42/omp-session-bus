import { toolRenderers } from "@oh-my-pi/pi-tui/tools";

// Newer hosts moved IRC rendering under wait; keep using their native message card.
const native = toolRenderers.hub ?? toolRenderers.wait;
export const sessionBusRenderer = toolRenderers.hub ?? {
  mergeCallAndResult: true,
  renderCall(args: Record<string, unknown>, options: unknown, theme: unknown) {
    return native.renderResult(
      {
        content: [],
        details: {
          op: "wait",
          waited: {
            from: "Session bus",
            body: `${args.op ?? "coordination"}${args.to ? ` → ${args.to}` : args.from ? ` ← ${args.from}` : ""}`,
            ts: Date.now(),
          },
        },
      },
      options,
      theme,
    );
  },
  renderResult(
    result: {
      content: Array<{ type: "text"; text: string }>;
      details?: unknown;
      isError?: boolean;
    },
    options: unknown,
    theme: unknown,
  ) {
    const details =
      result.details && typeof result.details === "object"
        ? (result.details as Record<string, unknown>)
        : {};
    if (details.waited) return native.renderResult(result, options, theme);
    return native.renderResult(
      {
        ...result,
        details: {
          op: "wait",
          waited: {
            from: "Session bus",
            body: result.content.map((part) => part.text).join("\n"),
            ts: Date.now(),
          },
        },
      },
      options,
      theme,
    );
  },
};
