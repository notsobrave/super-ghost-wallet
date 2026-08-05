import type { LogEntry } from "./types.js";

/**
 * In-page HUD: toasts announcing what the wallet just did, plus an optional
 * side panel holding the full request log. Purely for humans watching an agent
 * drive the browser — the wallet works identically with it off.
 *
 * Everything lives in a shadow root under a marked host element so the dApp's
 * styles, selectors and `document.querySelector` sweeps never see it (and so
 * findWcUri() can skip its own output).
 */

export const HUD_HOST = "sgw-hud";
/** Marks our host so page scans (e.g. findWcUri) can exclude it. */
export const HUD_ATTR = "data-sgw-hud";

export interface HudOptions {
  toasts: boolean;
  panel: boolean;
  position: "top-right" | "bottom-right" | "top-left" | "bottom-left";
}

const TOAST_MS = 5000;
const MAX_PANEL_ROWS = 100;
/** Capsule geometry — fully-rounded pill that a body stretches out of. */
const TOAST_W = 320;
const PILL_H = 44;
const PILL_R = PILL_H / 2;
const BODY_H = 46;
let gooId = 0;

const STATUS_LABEL: Record<string, string> = {
  approved: "signed",
  rejected: "rejected",
  error: "error",
  passthrough: "read",
  pending: "waiting",
};

/** Short human label for a request — what a real wallet's prompt would say. */
export function describe(entry: LogEntry): { title: string; detail: string } {
  const d = entry.decoded;
  switch (entry.method) {
    case "eth_requestAccounts":
      return { title: "Connect", detail: String(entry.result ?? "").slice(0, 42) };
    case "personal_sign":
      return {
        title: d?.kind === "siwe" ? "Sign-in (SIWE)" : "Sign message",
        detail: d?.siwe
          ? `${d.siwe.domain ?? ""} · nonce ${d.siwe.nonce ?? "?"}`
          : (d?.summary ?? ""),
      };
    case "eth_signTypedData":
    case "eth_signTypedData_v3":
    case "eth_signTypedData_v4":
      return { title: "Sign typed data", detail: d?.summary ?? "EIP-712" };
    case "eth_sendTransaction":
      return { title: "Transaction", detail: d?.summary ?? "" };
    case "solana_signIn":
      return { title: "Sign-in (SIWS)", detail: "solana" };
    case "solana_signMessage":
      return { title: "Sign message", detail: "solana" };
    case "solana_signTransaction":
    case "solana_signAndSendTransaction":
      return { title: "Transaction", detail: "solana" };
    case "solana_connect":
      return { title: "Connect", detail: "solana" };
    default:
      return { title: entry.method, detail: d?.summary ?? "" };
  }
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.root {
  position: fixed; z-index: 2147483647; display: flex; flex-direction: column;
  gap: 8px; max-width: 340px; color: #e8e9f0; font-size: 12px; line-height: 1.45;
}
.root[data-pos="top-right"]    { top: 16px; right: 16px; align-items: flex-end; }
.root[data-pos="bottom-right"] { bottom: 16px; right: 16px; align-items: flex-end; flex-direction: column-reverse; }
.root[data-pos="top-left"]     { top: 16px; left: 16px; align-items: flex-start; }
.root[data-pos="bottom-left"]  { bottom: 16px; left: 16px; align-items: flex-start; flex-direction: column-reverse; }

/* Toasts: a capsule that stretches a body out of itself, the two shapes
   merged by an SVG gooey filter so the growth reads as liquid, not as a
   second box appearing. Spring easing on entry; never interactive. */
.toast {
  pointer-events: none;               /* never intercepts a click meant for the dApp */
  position: relative; width: 320px; height: 44px;
  --fill: rgba(22, 24, 34, .96);
  --accent: #8b8bf4;
  animation: pop .42s cubic-bezier(.2, 1.28, .38, 1) both;
}
.toast[data-status="rejected"] { --accent: #f4a871; }
.toast[data-status="error"]    { --accent: #f47171; }
.toast[data-status="pending"]  { --accent: #8b8bf4; }
.toast.out { animation: sink .26s cubic-bezier(.4, 0, 1, .6) forwards; }
@keyframes pop {
  from { opacity: 0; transform: translateY(-10px) scale(.86); }
  to   { opacity: 1; transform: none; }
}
@keyframes sink { to { opacity: 0; transform: translateY(-6px) scale(.94); } }

.canvas { position: absolute; inset: 0; }
.canvas svg { overflow: visible; display: block; }
.pill, .body { fill: var(--fill); }
.body { transition: height .38s cubic-bezier(.2, 1.16, .4, 1), y .38s cubic-bezier(.2, 1.16, .4, 1); }
.shadow { filter: drop-shadow(0 8px 22px rgba(0, 0, 0, .45)); }

.head {
  position: absolute; top: 0; height: 44px; display: flex; align-items: center;
  gap: 7px; padding: 0 15px; white-space: nowrap;
}
.root[data-pos$="-right"] .head { right: 0; flex-direction: row-reverse; }
.root[data-pos$="-left"]  .head { left: 0; }
.ghost { font-size: 14px; line-height: 1; }
.toast .title { font-weight: 600; font-size: 12px; letter-spacing: .01em; color: #e8e9f0; }
.pip { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: 0 0 auto; }
.toast .detail {
  position: absolute; top: 44px; width: 320px; padding: 2px 16px 0;
  color: #9aa0b4; font-size: 11px; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  opacity: 0; transition: opacity .22s ease .12s;
}
.toast[data-open="true"] .detail { opacity: 1; }

.panel {
  width: 340px; max-height: 60vh; display: flex; flex-direction: column;
  border-radius: 12px; overflow: hidden;
  background: rgba(16, 18, 26, .96); border: 1px solid rgba(139, 139, 244, .28);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .45);
}
.panel-head {
  display: flex; align-items: center; gap: 8px; padding: 9px 12px;
  background: rgba(139, 139, 244, .1); border-bottom: 1px solid rgba(139, 139, 244, .2);
  cursor: pointer; user-select: none;
}
.panel-head .title { white-space: nowrap; }
.who {
  margin-left: auto; color: #8b8bf4; font-size: 10.5px; text-align: right;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rows { overflow-y: auto; padding: 4px 0; }
.panel[data-collapsed="true"] .rows { display: none; }
.row {
  display: flex; gap: 8px; align-items: baseline;
  padding: 5px 12px; border-bottom: 1px solid rgba(255, 255, 255, .04);
}
.row:last-child { border-bottom: 0; }
.time { color: #6a708a; font-size: 10.5px; flex: 0 0 auto; }
.row .title { font-size: 11.5px; }
.row .detail { -webkit-line-clamp: 1; margin: 0; font-size: 10.5px; }
.grow { min-width: 0; flex: 1; }
.dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: #7ddca4; }
.dot[data-status="rejected"] { background: #f4a871; }
.dot[data-status="error"]    { background: #f47171; }
.dot[data-status="pending"]  { background: #8b8bf4; }
.empty { padding: 12px; color: #6a708a; }
`;

const GHOST = "👻";

/** Build an element without ever touching innerHTML — this runs inside
 *  arbitrary pages, so the HUD keeps its DOM construction injection-proof. */
function el(
  tag: string,
  props: { class?: string; text?: string; dataset?: Record<string, string> } = {},
  ...children: Node[]
): HTMLElement {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.dataset ?? {})) node.dataset[k] = v;
  node.append(...children);
  return node;
}

export class Hud {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private toastLayer!: HTMLElement;
  private panelRows!: HTMLElement;
  private panelEl!: HTMLElement;
  private container!: HTMLElement;
  private options: HudOptions;
  private identity: () => string;

  constructor(options: HudOptions, identity: () => string = () => "") {
    this.options = options;
    this.identity = identity;
  }

  get enabled() {
    return this.options.toasts || this.options.panel;
  }

  setOptions(options: HudOptions) {
    this.options = options;
    if (!this.enabled) return this.destroy();
    this.mount();
    this.container.dataset.pos = options.position;
    this.panelEl.style.display = options.panel ? "" : "none";
    this.toastLayer.style.display = options.toasts ? "" : "none";
  }

  /** Idempotent: builds the shadow host on first use. */
  private mount() {
    if (this.host?.isConnected) return;
    const host = document.createElement(HUD_HOST);
    host.setAttribute(HUD_ATTR, "");
    // documentElement, not body: survives frameworks that replace <body>.
    document.documentElement.append(host);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;

    const container = document.createElement("div");
    container.className = "root";
    container.dataset.pos = this.options.position;

    const head = el(
      "div",
      { class: "panel-head" },
      el("span", { class: "ghost", text: GHOST }),
      el("span", { class: "title", text: "Super Ghost Wallet" }),
      el("span", { class: "who" }),
    );
    const rows = el("div", { class: "rows" }, this.emptyRow());
    const panel = el("div", { class: "panel", dataset: { collapsed: "false" } }, head, rows);
    head.addEventListener("click", () => {
      panel.dataset.collapsed = panel.dataset.collapsed === "true" ? "false" : "true";
    });

    const toasts = document.createElement("div");
    toasts.className = "toasts";

    container.append(toasts, panel);
    root.append(style, container);

    this.host = host;
    this.root = root;
    this.container = container;
    this.toastLayer = toasts;
    this.panelRows = rows;
    this.panelEl = panel;
  }

  /** Record an entry: toast (if enabled) + a panel row. */
  push(entry: LogEntry) {
    if (!this.enabled) return;
    this.mount();
    const { title, detail } = describe(entry);
    const status = entry.status;
    const who = this.identity();
    const whoEl = this.root!.querySelector(".who");
    if (whoEl) whoEl.textContent = who;

    if (this.options.panel) this.addRow(entry, title, detail);
    if (this.options.toasts) this.addToast(title, detail, status);
  }

  private emptyRow() {
    return el("div", { class: "empty", text: "no wallet activity yet" });
  }

  private addRow(entry: LogEntry, title: string, detail: string) {
    this.panelRows.querySelector(".empty")?.remove();
    const row = el(
      "div",
      { class: "row" },
      el("span", {
        class: "time",
        text: new Date(entry.ts).toLocaleTimeString(undefined, { hour12: false }),
      }),
      el("span", { class: "dot", dataset: { status: entry.status } }),
      el(
        "span",
        { class: "grow" },
        el("span", { class: "title", text: title }),
        el("div", { class: "detail", text: detail }),
      ),
    );
    this.panelRows.append(row);
    while (this.panelRows.children.length > MAX_PANEL_ROWS)
      this.panelRows.firstElementChild!.remove();
    this.panelRows.scrollTop = this.panelRows.scrollHeight;
  }

  private addToast(title: string, detail: string, status: LogEntry["status"]) {
    const rightAligned = this.options.position.endsWith("-right");
    const head = el(
      "div",
      { class: "head" },
      el("span", { class: "ghost", text: GHOST }),
      el("span", { class: "title", text: `${title} · ${STATUS_LABEL[status] ?? status}` }),
      el("span", { class: "pip" }),
    );
    const svg = this.buildCapsule();
    const toast = el(
      "div",
      { class: "toast", dataset: { status, open: "false" } },
      el("div", { class: "canvas" }, svg.node),
      head,
      el("div", { class: "detail", text: detail }),
    );
    this.toastLayer.append(toast);

    // Size the capsule to its title, the way a real pill hugs its label.
    const width = Math.min(TOAST_W, Math.max(PILL_H, head.scrollWidth + 12));
    svg.pill.setAttribute("width", String(width));
    svg.pill.setAttribute("x", String(rightAligned ? TOAST_W - width : 0));

    // Then let a body stretch out of it — the gooey filter turns the two
    // rects into one blob mid-transition instead of two stacked shapes.
    if (detail) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          svg.body.setAttribute("height", String(BODY_H));
          toast.dataset.open = "true";
          toast.style.height = `${PILL_H + BODY_H - PILL_R}px`;
        }),
      );
    }

    setTimeout(() => {
      svg.body.setAttribute("height", "0");
      toast.dataset.open = "false";
      toast.classList.add("out");
      setTimeout(() => toast.remove(), 280);
    }, TOAST_MS);
  }

  /** Pill + body rects merged by a gooey filter, scoped to this toast. */
  private buildCapsule() {
    const NS = "http://www.w3.org/2000/svg";
    const id = `sgw-goo-${++gooId}`;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(TOAST_W));
    svg.setAttribute("height", String(PILL_H + BODY_H));
    svg.setAttribute("class", "shadow");

    const defs = document.createElementNS(NS, "defs");
    const filter = document.createElementNS(NS, "filter");
    filter.setAttribute("id", id);
    filter.setAttribute("x", "-20%");
    filter.setAttribute("y", "-20%");
    filter.setAttribute("width", "140%");
    filter.setAttribute("height", "140%");
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const blur = document.createElementNS(NS, "feGaussianBlur");
    blur.setAttribute("in", "SourceGraphic");
    blur.setAttribute("stdDeviation", String(PILL_R * 0.34));
    blur.setAttribute("result", "blur");
    // Crush the blurred alpha back to a hard edge: overlapping shapes fuse,
    // separate ones keep their own outline. This is what makes it "liquid".
    const matrix = document.createElementNS(NS, "feColorMatrix");
    matrix.setAttribute("in", "blur");
    matrix.setAttribute("mode", "matrix");
    matrix.setAttribute("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10");
    filter.append(blur, matrix);
    defs.append(filter);

    const group = document.createElementNS(NS, "g");
    group.setAttribute("filter", `url(#${id})`);
    const pill = document.createElementNS(NS, "rect");
    pill.setAttribute("class", "pill");
    pill.setAttribute("y", "0");
    pill.setAttribute("height", String(PILL_H));
    pill.setAttribute("rx", String(PILL_R));
    pill.setAttribute("width", String(TOAST_W));
    pill.setAttribute("x", "0");
    const body = document.createElementNS(NS, "rect");
    body.setAttribute("class", "body");
    body.setAttribute("x", "0");
    // Overlap the pill by its radius so the two shapes touch and fuse.
    body.setAttribute("y", String(PILL_H - PILL_R));
    body.setAttribute("width", String(TOAST_W));
    body.setAttribute("height", "0");
    body.setAttribute("rx", String(PILL_R * 0.7));
    group.append(pill, body);
    svg.append(defs, group);
    return { node: svg, pill, body };
  }

  /** Free-form note from the agent ("about to connect…"). */
  note(text: string, detail = "") {
    if (!this.enabled) return;
    this.mount();
    if (this.options.toasts) this.addToast(text, detail, "pending");
    if (this.options.panel)
      this.addRow(
        { id: 0, ts: Date.now(), method: "note", params: null, status: "pending" },
        text,
        detail,
      );
  }

  clear() {
    if (!this.host) return;
    this.toastLayer.replaceChildren();
    this.panelRows.replaceChildren(this.emptyRow());
  }

  destroy() {
    this.host?.remove();
    this.host = null;
    this.root = null;
  }
}
