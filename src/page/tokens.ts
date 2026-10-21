// Turnstile token source, independent of the DOM (dom/turnstile.ts supplies the script
// loader). Tokens are single-use (300 s), so each init gets a fresh one: execute, wait for
// the callback, and reset before the next execute.

export interface TurnstileApi<El> {
  render(el: El, opts: Record<string, unknown>): string;
  execute(id: string): void;
  reset(id: string): void;
}

/** With no sitekey (Turnstile off) the source yields no token and never calls `load`. */
export function tokenSource<El>(
  sitekey: string | null,
  el: El,
  load: () => Promise<TurnstileApi<El>>,
): () => Promise<string | undefined> {
  if (sitekey === null) return async () => undefined;

  let widget: string | undefined;
  let used = false;
  let pending: { resolve: (t: string) => void; reject: (e: Error) => void } | undefined;

  return async () => {
    const ts = await load();
    const token = new Promise<string>((resolve, reject) => (pending = { resolve, reject }));
    if (widget === undefined) {
      widget = ts.render(el, {
        sitekey,
        execution: "execute",
        appearance: "interaction-only",
        callback: (t: string) => pending?.resolve(t),
        "error-callback": () => pending?.reject(new Error("Bot check failed — tap to retry.")),
        // An unanswered interactive challenge: fail the row instead of leaving it at 0 %.
        "timeout-callback": () => pending?.reject(new Error("Bot check timed out — tap to retry.")),
        "expired-callback": () => (used = true),
      });
    } else if (used) {
      ts.reset(widget);
    }
    used = true;
    ts.execute(widget);
    return token;
  };
}
