import { Container, type Component, type Theme } from "@oh-my-pi/pi-tui";
import {
  createCachedComponent,
  renderStatusLine,
  replaceTabs,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui/render";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import { outgoingView, type BusRenderResult } from "./outgoing-view.ts";

// Incoming messages retain the host's native IRC renderer on both host generations.
const native = toolRenderers.hub ?? toolRenderers.wait;

function card(
  title: string,
  body: string,
  status: "pending" | "success" | "warning" | "error",
  summary: string,
  options: unknown,
  theme: unknown,
  error?: string,
): Component {
  // The host supplies its Theme; the extension API exposes it as unknown.
  const uiTheme = theme as Theme;
  const header = renderStatusLine(
    { icon: status, title, meta: summary ? [summary] : [] },
    theme,
  );
  const bodyRows = replaceTabs(body.replace(/\r\n?/g, "\n")).split("\n");
  const errorRows = error
    ? replaceTabs(error.replace(/\r\n?/g, "\n")).split("\n")
    : [];
  return createCachedComponent(
    () =>
      !!options &&
      typeof options === "object" &&
      "expanded" in options &&
      options.expanded === true,
    (width, expanded) => {
      const rows = wrapTextWithAnsi(header, width);
      const innerWidth = Math.max(1, width - 2);
      const append = (text: string, tone: string) => {
        const lines = expanded
          ? wrapTextWithAnsi(text, innerWidth)
          : [truncateToWidth(text, innerWidth)];
        for (const line of lines) rows.push(`  ${uiTheme.fg(tone, line)}`);
      };
      if (body) {
        for (const line of expanded ? bodyRows : bodyRows.slice(0, 1))
          append(line, "dim");
        if (!expanded && bodyRows.length > 1)
          append(`… +${bodyRows.length - 1} lines`, "dim");
      }
      for (const line of expanded ? errorRows : errorRows.slice(0, 1))
        append(line, "error");
      return rows;
    },
  );
}

export const sessionBusRenderer = {
  mergeCallAndResult: true,
  renderCall(args: Record<string, unknown>, options: unknown, theme: unknown) {
    const outgoing = outgoingView(args);
    if (outgoing)
      return card(
        `${outgoing.label} → ${outgoing.target}`,
        outgoing.body,
        outgoing.status,
        outgoing.summary,
        options,
        theme,
      );
    if (toolRenderers.hub) return native.renderCall(args, options, theme);
    return card(
      `Session bus · ${args.op ?? "coordination"}`,
      "",
      "pending",
      "",
      options,
      theme,
    );
  },
  renderResult(
    result: BusRenderResult,
    options: unknown,
    theme: unknown,
    args?: Record<string, unknown>,
  ) {
    const outgoing = outgoingView(args, result);
    if (outgoing) {
      const sent = card(
        `${outgoing.label} → ${outgoing.target}`,
        outgoing.body,
        outgoing.status,
        outgoing.summary,
        options,
        theme,
        outgoing.error,
      );
      if (!outgoing.waited) return sent;
      const exchange = new Container();
      exchange.addChild(sent);
      exchange.addChild(
        native.renderResult(
          { content: [], details: { op: "wait", waited: outgoing.waited } },
          options,
          theme,
        ),
      );
      return exchange;
    }
    const details =
      result.details && typeof result.details === "object"
        ? (result.details as Record<string, unknown>)
        : {};
    if (details.waited || toolRenderers.hub)
      return native.renderResult(result, options, theme, args);
    return card(
      `Session bus · ${args?.op ?? "result"}`,
      result.content.map((part) => part.text).join("\n"),
      result.isError ? "error" : "success",
      "",
      options,
      theme,
    );
  },
};
