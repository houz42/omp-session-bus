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
      ): unknown;
      renderResult(
        result: {
          content: Array<{ type: "text"; text: string }>;
          details?: unknown;
          isError?: boolean;
        },
        options: unknown,
        theme: unknown,
        args?: Record<string, unknown>,
      ): unknown;
    }
  >;
}
