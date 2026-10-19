// Cloudflare Turnstile, explicit render. Tokens are single-use (300 s), so each init gets
// a fresh one: execute, wait for the callback, and reset before the next execute.

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  execute(id: string): void;
  reset(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Returns a token source; with an empty sitekey it yields no token and loads nothing. */
export function turnstileTokens(sitekey: string, el: HTMLElement): () => Promise<string | undefined> {
  if (sitekey === "") return async () => undefined;

  let api: Promise<TurnstileApi> | undefined;
  let widget: string | undefined;
  let used = false;
  let pending: { resolve: (t: string) => void; reject: (e: Error) => void } | undefined;

  const load = (): Promise<TurnstileApi> =>
    (api ??= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SCRIPT;
      s.async = true;
      s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not load.")));
      s.onerror = () => {
        api = undefined;
        reject(new Error("Couldn't load the bot check — check your signal and retry."));
      };
      document.head.append(s);
    }));

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
