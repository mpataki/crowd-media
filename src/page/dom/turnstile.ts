// Cloudflare Turnstile, explicit render: loads the script once and hands it to the
// DOM-free token source (../tokens.ts).
import { tokenSource, type TurnstileApi } from "../tokens";

declare global {
  interface Window {
    turnstile?: TurnstileApi<HTMLElement>;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Returns a token source; with no sitekey (Turnstile off) it yields no token and loads nothing. */
export function turnstileTokens(sitekey: string | null, el: HTMLElement): () => Promise<string | undefined> {
  let api: Promise<TurnstileApi<HTMLElement>> | undefined;
  const load = (): Promise<TurnstileApi<HTMLElement>> =>
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
  return tokenSource(sitekey, el, load);
}
