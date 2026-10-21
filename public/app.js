// src/page/base.ts
function apiBase(pathname) {
  const first = pathname.split("/").find((s) => s !== "");
  if (first === void 0 || first.includes(".")) return "/api";
  return `/${first}/api`;
}

// src/page/dom/el.ts
function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el;
}
function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

// src/page/precheck.ts
var MIB = 1024 * 1024;
var NOT_MEDIA = "Only photos and videos can be uploaded.";
function precheck(file, accept) {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!accept.extensions.includes(ext)) return NOT_MEDIA;
  if (file.type !== "" && !file.type.startsWith("image/") && !file.type.startsWith("video/")) return NOT_MEDIA;
  if (file.size === 0) return "This file is empty.";
  if (file.size > accept.maxFileMb * MIB) {
    return `Too big \u2014 the limit is ${formatMb(accept.maxFileMb)} per file.`;
  }
  return null;
}
function formatMb(mb) {
  return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}

// src/page/text.ts
function consentText(band) {
  return `By uploading you agree ${band} may post this on our socials. We never publish your name without asking.`;
}
function summaryText(sent, failed, band) {
  const files = sent === 1 ? "1 file" : `${sent} files`;
  const tail = failed === 0 ? "" : ` ${failed} failed \u2014 tap to retry.`;
  return `Thanks! ${files} sent to ${band}.${tail}`;
}
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function showLabel(show) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(show.starts);
  if (!m) return show.venue;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${show.venue}, ${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function onAccent(accent) {
  const m = /^#([0-9a-f]{6})$/i.exec(accent);
  if (!m) return "#fff";
  const hex = m[1];
  const lum = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
  return 1.05 / (l + 0.05) >= 4.5 ? "#fff" : "#000";
}

// src/page/plan.ts
function planParts(size, partSize) {
  if (!Number.isInteger(partSize) || partSize <= 0) {
    throw new Error(`partSize must be a positive integer, got ${partSize}`);
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`size must be a positive integer, got ${size}`);
  }
  const plan = [];
  for (let start = 0, n = 1; start < size; start += partSize, n++) {
    plan.push({ n, start, end: Math.min(start + partSize, size) });
  }
  return plan;
}

// src/page/retry.ts
var MAX_RETRIES = 3;
var BACKOFF_BASE_MS = 500;
function isRetryable(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}
function retryDelay(failures, status) {
  if (!isRetryable(status) || failures > MAX_RETRIES) return null;
  return BACKOFF_BASE_MS * 2 ** (failures - 1);
}

// src/page/upload.ts
var UploadError = class extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
};
var NETWORK = "Connection lost \u2014 check your signal.";
var BUSY = "Busy \u2014 retrying in a minute\u2026";
async function uploadFile(file, meta, deps, onProgress, onWait = () => {
}) {
  let init;
  try {
    init = await startUpload(file, meta, deps);
  } catch (err) {
    if (!(err instanceof UploadError && err.status === 429 && err.retryAfter !== void 0)) throw err;
    onWait(BUSY);
    await deps.sleep(err.retryAfter * 1e3);
    init = await startUpload(file, meta, deps);
  }
  const upload = `${deps.base}/uploads/${encodeURIComponent(init.id)}`;
  try {
    const plan = planParts(file.size, init.partSize);
    if (plan.length !== init.parts) {
      throw new UploadError(0, `Server planned ${init.parts} parts, page planned ${plan.length}.`);
    }
    const done = [];
    let acked = 0;
    onProgress(0);
    for (const part of plan) {
      const { etag } = await withRetry(
        deps,
        () => call(deps, `${upload}/parts/${part.n}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: file.slice(part.start, part.end)
        })
      );
      done.push({ n: part.n, etag });
      acked += part.end - part.start;
      onProgress(acked);
    }
    return await withRetry(
      deps,
      () => call(deps, `${upload}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: done })
      })
    );
  } catch (err) {
    await deps.fetch(upload, { method: "DELETE" }).catch(() => void 0);
    throw err;
  }
}
async function startUpload(file, meta, deps) {
  const turnstileToken = await deps.token();
  return call(deps, `${deps.base}/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      ...meta.credit ? { credit: meta.credit } : {},
      ...meta.showId ? { showId: meta.showId } : {},
      ...turnstileToken ? { turnstileToken } : {}
    })
  });
}
async function withRetry(deps, attempt) {
  for (let failures = 1; ; failures++) {
    try {
      return await attempt();
    } catch (err) {
      const status = err instanceof UploadError ? err.status : 0;
      const delay = retryDelay(failures, status);
      if (delay === null) throw err;
      await deps.sleep(delay);
    }
  }
}
async function call(deps, url, init) {
  let res;
  try {
    res = await deps.fetch(url, init);
  } catch {
    throw new UploadError(0, NETWORK);
  }
  if (!res.ok) {
    const { reason, retryAfter } = await errorOf(res);
    throw new UploadError(res.status, reason, retryAfter);
  }
  return await res.json();
}
async function reasonOf(res) {
  return (await errorOf(res)).reason;
}
async function errorOf(res) {
  let reason = `Upload failed (HTTP ${res.status}).`;
  let retryAfter;
  try {
    const body = await res.json();
    if (typeof body.reason === "string" && body.reason !== "") reason = body.reason;
    if (typeof body.retryAfter === "number" && body.retryAfter >= 0) retryAfter = body.retryAfter;
  } catch {
  }
  return { reason, retryAfter };
}

// src/page/dom/queue.ts
var Queue = class {
  constructor(o) {
    this.o = o;
    this.items = [];
    this.running = false;
    this.sent = 0;
    this.failed = 0;
  }
  add(files) {
    for (const file of files) {
      const name = h("span", { className: "name", textContent: file.name || "(unnamed)" });
      const bar = h("progress", { max: 100, value: 0 });
      const status = h("span", { className: "state" });
      const action = h("div");
      const row = h("li", {}, name, bar, status, action);
      bar.setAttribute("aria-label", `${file.name} progress`);
      const item = { file, state: "ready", row, bar, status, action };
      const reason = precheck(file, this.o.accept);
      if (reason) {
        item.state = "rejected";
        bar.hidden = true;
        status.textContent = reason;
      } else {
        status.textContent = "Ready";
      }
      this.items.push(item);
      this.o.list.append(row);
    }
    this.o.summary.textContent = "";
    this.o.onChange();
  }
  readyCount() {
    return this.items.filter((i) => i.state === "ready").length;
  }
  isRunning() {
    return this.running;
  }
  start() {
    for (const i of this.items) if (i.state === "ready") this.set(i, "queued", "Waiting\u2026");
    void this.drain();
  }
  /** Drop finished and rejected rows, keep anything still pending or failed. */
  clearFinished() {
    this.items = this.items.filter((i) => {
      const keep = i.state !== "done" && i.state !== "rejected";
      if (!keep) i.row.remove();
      return keep;
    });
    this.o.summary.textContent = "";
    this.o.onChange();
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    this.o.onChange();
    for (let next = this.nextQueued(); next; next = this.nextQueued()) {
      await this.run(next);
    }
    this.running = false;
    if (this.sent + this.failed > 0) {
      this.o.summary.textContent = summaryText(this.sent, this.failed, this.o.band);
    }
    this.sent = 0;
    this.failed = 0;
    this.o.onChange();
  }
  nextQueued() {
    return this.items.find((i) => i.state === "queued");
  }
  async run(item) {
    item.action.replaceChildren();
    item.bar.value = 0;
    this.set(item, "uploading", "Uploading 0 %");
    const size = item.file.size;
    try {
      await uploadFile(item.file, this.o.meta(), this.o.deps, (acked) => {
        const pct = Math.floor(acked / size * 100);
        item.bar.value = pct;
        item.status.textContent = `Uploading ${pct} %`;
      }, (message) => item.status.textContent = message);
      item.bar.value = 100;
      this.set(item, "done", "Done \u2713");
      this.sent++;
    } catch (err) {
      this.set(item, "failed", "");
      this.failed++;
      const reason = h("p", { className: "reason", textContent: err instanceof Error ? err.message : String(err) });
      const retry = h("button", { type: "button", textContent: "Failed \u2014 tap to retry" });
      retry.addEventListener("click", () => {
        this.set(item, "queued", "Waiting\u2026");
        item.action.replaceChildren();
        this.o.summary.textContent = "";
        void this.drain();
      });
      item.action.replaceChildren(reason, retry);
    }
  }
  set(item, state, text) {
    item.state = state;
    item.row.dataset.state = state;
    item.status.textContent = text;
  }
};

// src/page/tokens.ts
function tokenSource(sitekey, el, load) {
  if (sitekey === null) return async () => void 0;
  let widget;
  let used = false;
  let pending;
  return async () => {
    const ts = await load();
    const token = new Promise((resolve, reject) => pending = { resolve, reject });
    if (widget === void 0) {
      widget = ts.render(el, {
        sitekey,
        execution: "execute",
        appearance: "interaction-only",
        callback: (t) => pending?.resolve(t),
        "error-callback": () => pending?.reject(new Error("Bot check failed \u2014 tap to retry.")),
        "expired-callback": () => used = true
      });
    } else if (used) {
      ts.reset(widget);
    }
    used = true;
    ts.execute(widget);
    return token;
  };
}

// src/page/dom/turnstile.ts
var SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
function turnstileTokens(sitekey, el) {
  let api;
  const load = () => api ?? (api = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not load."));
    s.onerror = () => {
      api = void 0;
      reject(new Error("Couldn't load the bot check \u2014 check your signal and retry."));
    };
    document.head.append(s);
  }));
  return tokenSource(sitekey, el, load);
}

// src/page/main.ts
var CREDIT_KEY = "crowd-media:credit";
async function boot() {
  const base = apiBase(location.pathname);
  const status = byId("status");
  let info;
  try {
    const res = await fetch(`${base}/band`);
    if (!res.ok) throw new Error(await reasonOf(res));
    info = await res.json();
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
  const credit = byId("credit");
  credit.value = localStorage.getItem(CREDIT_KEY) ?? "";
  credit.addEventListener("change", () => localStorage.setItem(CREDIT_KEY, credit.value.trim()));
  const files = byId("files");
  const upload = byId("upload");
  const more = byId("more");
  const queue = new Queue({
    list: byId("queue"),
    summary: byId("summary"),
    band: info.band.name,
    accept: info.accept,
    deps: {
      fetch: (u, i) => fetch(u, i),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      base,
      token: turnstileTokens(info.turnstile?.sitekey ?? null, byId("turnstile"))
    },
    meta: () => ({ credit: credit.value.trim() || void 0, showId: picked() }),
    onChange: () => {
      const n = queue.readyCount();
      upload.disabled = n === 0;
      upload.textContent = n > 1 ? `Upload ${n} files` : "Upload";
      more.hidden = queue.isRunning() || byId("summary").textContent === "";
    }
  });
  files.addEventListener("change", () => {
    if (files.files) queue.add(files.files);
    files.value = "";
  });
  byId("form").addEventListener("submit", (e) => {
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
function renderBand(info) {
  const { name } = info.band;
  document.title = `Send ${name} your photos & videos`;
  byId("band-name").textContent = name;
  byId("blurb").textContent = info.theme.blurb;
  byId("consent").textContent = consentText(name);
  if (info.theme.logo) {
    const logo = byId("logo");
    logo.src = info.theme.logo;
    logo.alt = `${name} logo`;
    logo.hidden = false;
  }
  if (/^#[0-9a-f]{6}$/i.test(info.theme.accent)) {
    document.documentElement.style.setProperty("--accent", info.theme.accent);
    document.documentElement.style.setProperty("--on-accent", onAccent(info.theme.accent));
  }
}
function renderShow(info) {
  const text = byId("show-text");
  const change = byId("show-change");
  const picker = byId("show-picker");
  let override;
  const banner = (show) => {
    if (show) {
      text.replaceChildren("Uploading to ", h("strong", { textContent: showLabel(show) }), ".");
    } else {
      text.textContent = "No recent show \u2014 we'll sort it by date.";
    }
  };
  banner(info.show);
  if (info.recent.length === 0) return () => void 0;
  change.hidden = false;
  change.textContent = info.show ? "Not this one?" : "Pick a show";
  change.addEventListener("click", () => {
    picker.hidden = !picker.hidden;
    change.setAttribute("aria-expanded", String(!picker.hidden));
  });
  const option = (value, label, checked) => {
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
    option("", "None of these", info.show === null)
  );
  return () => override;
}
void boot();
