import { apiBase } from "./base";
import { byId, h } from "./dom/el";
import { Queue } from "./dom/queue";
import { turnstileTokens } from "./dom/turnstile";
import { consentText, onAccent, showLabel } from "./text";
import type { BandInfo, Show } from "./types";
import { reasonOf } from "./upload";

const CREDIT_KEY = "crowd-media:credit";

async function boot(): Promise<void> {
  const base = apiBase(location.pathname);
  const status = byId<HTMLParagraphElement>("status");
  let info: BandInfo;
  try {
    const res = await fetch(`${base}/band`);
    if (!res.ok) throw new Error(await reasonOf(res));
    info = (await res.json()) as BandInfo;
  } catch (err) {
    status.textContent = `Couldn't load this page: ${err instanceof Error ? err.message : String(err)} Reload to try again.`;
    return;
  }

  renderBand(info);
  const picked = renderShow(info);
  if (info.paused) {
    status.textContent = `Uploads for ${info.band.name} are paused right now.`;
    return;
  }

  const credit = byId<HTMLInputElement>("credit");
  credit.value = localStorage.getItem(CREDIT_KEY) ?? "";
  credit.addEventListener("change", () => localStorage.setItem(CREDIT_KEY, credit.value.trim()));

  const files = byId<HTMLInputElement>("files");
  const upload = byId<HTMLButtonElement>("upload");
  const more = byId<HTMLButtonElement>("more");
  const queue: Queue = new Queue({
    list: byId("queue"),
    summary: byId("summary"),
    band: info.band.name,
    accept: info.accept,
    deps: {
      fetch: (u, i) => fetch(u, i),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      base,
      token: turnstileTokens(info.turnstile.sitekey, byId("turnstile")),
    },
    meta: () => ({ credit: credit.value.trim() || undefined, showId: picked() }),
    onChange: () => {
      const n = queue.readyCount();
      upload.disabled = n === 0;
      upload.textContent = n > 1 ? `Upload ${n} files` : "Upload";
      more.hidden = queue.isRunning() || byId("summary").textContent === "";
    },
  });

  files.addEventListener("change", () => {
    if (files.files) queue.add(files.files);
    files.value = "";
  });
  byId<HTMLFormElement>("form").addEventListener("submit", (e) => {
    e.preventDefault();
    localStorage.setItem(CREDIT_KEY, credit.value.trim());
    queue.start();
  });
  more.addEventListener("click", () => {
    queue.clearFinished();
    files.click();
  });
  byId("form").hidden = false;
}

function renderBand(info: BandInfo): void {
  const { name } = info.band;
  document.title = `Send ${name} your photos & videos`;
  byId("band-name").textContent = name;
  byId("blurb").textContent = info.theme.blurb;
  byId("consent").textContent = consentText(name);
  if (info.theme.logo) {
    const logo = byId<HTMLImageElement>("logo");
    logo.src = info.theme.logo;
    logo.alt = `${name} logo`;
    logo.hidden = false;
  }
  if (/^#[0-9a-f]{6}$/i.test(info.theme.accent)) {
    document.documentElement.style.setProperty("--accent", info.theme.accent);
    document.documentElement.style.setProperty("--on-accent", onAccent(info.theme.accent));
  }
}

/**
 * Banner + "Not this one?" picker. Returns the guest's override: a show id, or undefined
 * (no override, or "none of these" — both leave attribution to the server).
 */
function renderShow(info: BandInfo): () => string | undefined {
  const text = byId("show-text");
  const change = byId<HTMLButtonElement>("show-change");
  const picker = byId<HTMLFieldSetElement>("show-picker");
  let override: string | undefined;

  const banner = (show: Show | null): void => {
    if (show) {
      text.replaceChildren("Uploading to ", h("strong", { textContent: showLabel(show) }), ".");
    } else {
      text.textContent = "No recent show — we'll sort it by date.";
    }
  };
  banner(info.show);

  if (info.recent.length === 0) return () => undefined;
  change.hidden = false;
  change.textContent = info.show ? "Not this one?" : "Pick a show";
  change.addEventListener("click", () => {
    picker.hidden = !picker.hidden;
    change.setAttribute("aria-expanded", String(!picker.hidden));
  });

  const option = (value: string, label: string, checked: boolean): HTMLLabelElement => {
    const radio = h("input", { type: "radio", name: "show", value, checked });
    radio.addEventListener("change", () => {
      const show = info.recent.find((s) => s.id === value) ?? null;
      override = show?.id;
      banner(show);
    });
    return h("label", {}, radio, ` ${label}`);
  };
  picker.append(
    ...info.recent.map((s) => option(s.id, showLabel(s), s.id === info.show?.id)),
    option("", "None of these", info.show === null),
  );
  return () => override;
}

void boot();
