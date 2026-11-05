// Runtime implementation is supplied by omp's bundled extension loader, not npm.
declare module "@oh-my-pi/pi-tui/tools" {
  export const toolRenderers: Record<
    string,
    {
      mergeCallAndResult: boolean;
      renderCall(
        args: Record<string, unknown>,
        options: unknown,
        theme: unknown,
      ): import("@oh-my-pi/pi-tui").Component;
      renderResult(
        result: {
          content: Array<{ type: "text"; text: string }>;
          details?: unknown;
          isError?: boolean;
        },
        options: unknown,
        theme: unknown,
        args?: Record<string, unknown>,
      ): import("@oh-my-pi/pi-tui").Component;
    }
  >;
}

declare module "@oh-my-pi/pi-tui" {
  export interface Component {
    render(width: number): readonly string[];
    invalidate(): void;
  }
  export interface Theme {
    fg(color: string, text: string): string;
  }
  export class Container implements Component {
    addChild(child: Component): void;
    render(width: number): readonly string[];
    invalidate(): void;
  }
}

declare module "@oh-my-pi/pi-tui/render" {
  export function createCachedComponent(
    getExpanded: () => boolean,
    compute: (width: number, expanded: boolean) => string[],
  ): import("@oh-my-pi/pi-tui").Component;
  export function renderStatusLine(
    options: { icon: string; title: string; meta?: string[] },
    theme: unknown,
  ): string;
  export function replaceTabs(text: string): string;
  export function truncateToWidth(text: string, width: number): string;
  export function wrapTextWithAnsi(text: string, width: number): string[];
}
