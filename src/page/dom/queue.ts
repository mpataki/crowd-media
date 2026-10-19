import { precheck } from "../precheck";
import { summaryText } from "../text";
import { uploadFile, type UploadDeps, type UploadMeta } from "../upload";
import { h } from "./el";

type State = "ready" | "queued" | "uploading" | "done" | "failed" | "rejected";

interface Item {
  file: File;
  state: State;
  row: HTMLLIElement;
  bar: HTMLProgressElement;
  status: HTMLSpanElement;
  action: HTMLDivElement;
}

export interface QueueOptions {
  list: HTMLUListElement;
  summary: HTMLElement;
  band: string;
  caps: { fileMb: number };
  deps: UploadDeps;
  /** Read at each file's init, so credit/show edits mid-queue apply to later files. */
  meta: () => UploadMeta;
  onChange: () => void;
}

/** One file at a time, in order. A failed file never blocks the rest. */
export class Queue {
  private items: Item[] = [];
  private running = false;
  private sent = 0;
  private failed = 0;

  constructor(private readonly o: QueueOptions) {}

  add(files: Iterable<File>): void {
    for (const file of files) {
      const name = h("span", { className: "name", textContent: file.name || "(unnamed)" });
      const bar = h("progress", { max: 100, value: 0 });
      const status = h("span", { className: "state" });
      const action = h("div");
      const row = h("li", {}, name, bar, status, action);
      bar.setAttribute("aria-label", `${file.name} progress`);
      const item: Item = { file, state: "ready", row, bar, status, action };
      const reason = precheck(file, this.o.caps);
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

  readyCount(): number {
    return this.items.filter((i) => i.state === "ready").length;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    for (const i of this.items) if (i.state === "ready") this.set(i, "queued", "Waiting…");
    void this.drain();
  }

  /** Drop finished and rejected rows, keep anything still pending or failed. */
  clearFinished(): void {
    this.items = this.items.filter((i) => {
      const keep = i.state !== "done" && i.state !== "rejected";
      if (!keep) i.row.remove();
      return keep;
    });
    this.o.summary.textContent = "";
    this.o.onChange();
  }

  private async drain(): Promise<void> {
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

  private nextQueued(): Item | undefined {
    return this.items.find((i) => i.state === "queued");
  }

  private async run(item: Item): Promise<void> {
    item.action.replaceChildren();
    item.bar.value = 0;
    this.set(item, "uploading", "Uploading 0 %");
    const size = item.file.size;
    try {
      await uploadFile(item.file, this.o.meta(), this.o.deps, (acked) => {
        const pct = Math.floor((acked / size) * 100);
        item.bar.value = pct;
        item.status.textContent = `Uploading ${pct} %`;
      });
      item.bar.value = 100;
      this.set(item, "done", "Done ✓");
      this.sent++;
    } catch (err) {
      this.set(item, "failed", "");
      this.failed++;
      const reason = h("p", { className: "reason", textContent: err instanceof Error ? err.message : String(err) });
      const retry = h("button", { type: "button", textContent: "Failed — tap to retry" });
      retry.addEventListener("click", () => {
        this.set(item, "queued", "Waiting…");
        item.action.replaceChildren();
        this.o.summary.textContent = "";
        void this.drain();
      });
      item.action.replaceChildren(reason, retry);
    }
  }

  private set(item: Item, state: State, text: string): void {
    item.state = state;
    item.row.dataset.state = state;
    item.status.textContent = text;
  }
}
