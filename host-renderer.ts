import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import { senderLabel } from "./sender-display.ts";

// Newer hosts moved IRC rendering under wait; keep using their native message card.
const native = toolRenderers.hub ?? toolRenderers.wait;
const baseRenderer = toolRenderers.hub ?? {
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

export const sessionBusRenderer = {
  ...baseRenderer,
  renderResult(
    result: {
      content: Array<{ type: "text"; text: string }>;
      details?: unknown;
      isError?: boolean;
    },
    options: unknown,
    theme: unknown,
    args?: Record<string, unknown>,
  ) {
    const details = result.details;
    if (details && typeof details === "object" && "waited" in details) {
      const waited = details.waited;
      if (
        waited &&
        typeof waited === "object" &&
        "from" in waited &&
        typeof waited.from === "string"
      ) {
        const label = senderLabel({
          from: waited.from,
          senderTitle:
            "senderTitle" in waited && typeof waited.senderTitle === "string"
              ? waited.senderTitle
              : undefined,
          broadcast: "broadcast" in waited && waited.broadcast === true,
        });
        // Render a copy only: result.details.waited.from remains the full routing key.
        return baseRenderer.renderResult(
          {
            ...result,
            details: { ...details, waited: { ...waited, from: label } },
          },
          options,
          theme,
          args,
        );
      }
    }
    return baseRenderer.renderResult(result, options, theme, args);
  },
};
