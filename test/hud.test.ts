// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { Hud, HUD_ATTR, HUD_HOST, describe as describeEntry } from "../src/hud.js";
import { clearWcUri, findWcUri } from "../src/control.js";
import type { LogEntry } from "../src/types.js";

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: 1,
  ts: Date.parse("2026-08-05T12:34:56Z"),
  method: "personal_sign",
  params: [],
  status: "approved",
  ...over,
});

const host = () => document.querySelector(`${HUD_HOST}`);
const shadow = () => host()?.shadowRoot ?? null;
const on = { toasts: true, panel: true, position: "top-right" } as const;

describe("hud lifecycle", () => {
  beforeEach(() => {
    document.querySelectorAll(HUD_HOST).forEach((n) => n.remove());
  });

  it("renders nothing while disabled", () => {
    const hud = new Hud({ toasts: false, panel: false, position: "top-right" });
    hud.push(entry());
    expect(host()).toBeNull();
  });

  it("mounts a marked shadow host on first activity", () => {
    const hud = new Hud({ ...on });
    hud.push(entry());
    expect(host()).not.toBeNull();
    expect(host()!.hasAttribute(HUD_ATTR)).toBe(true);
    // isolated: the dApp's own DOM stays untouched
    expect(shadow()!.querySelector(".toast")).not.toBeNull();
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("toasts never intercept clicks meant for the dApp", () => {
    const hud = new Hud({ ...on });
    hud.push(entry());
    const css = shadow()!.querySelector("style")!.textContent!;
    expect(css).toMatch(/\.toast\s*{[^}]*pointer-events:\s*none/);
  });

  it("adds a panel row per action and drops the empty state", () => {
    const hud = new Hud({ ...on });
    expect(shadow()).toBeNull();
    hud.push(entry());
    expect(shadow()!.querySelector(".empty")).toBeNull();
    hud.push(entry({ id: 2, method: "eth_sendTransaction" }));
    expect(shadow()!.querySelectorAll(".row")).toHaveLength(2);
  });

  it("marks rejected and error states distinctly", () => {
    const hud = new Hud({ ...on });
    hud.push(entry({ status: "rejected" }));
    expect(shadow()!.querySelector(".toast")!.getAttribute("data-status")).toBe("rejected");
    expect(shadow()!.querySelector(".toast .title")!.textContent).toContain("rejected");
    expect(shadow()!.querySelector(".dot")!.getAttribute("data-status")).toBe("rejected");
  });

  it("builds a gooey capsule: pill + body fused by a scoped filter", () => {
    const hud = new Hud({ ...on });
    hud.push(entry());
    const svg = shadow()!.querySelector(".toast svg")!;
    const filter = svg.querySelector("filter")!;
    const group = svg.querySelector("g")!;
    // the group references THIS toast's filter, not a shared global id
    expect(group.getAttribute("filter")).toBe(`url(#${filter.getAttribute("id")})`);
    expect(filter.querySelector("feGaussianBlur")).not.toBeNull();
    expect(filter.querySelector("feColorMatrix")).not.toBeNull();
    // body starts collapsed and overlaps the pill so the two shapes can fuse
    const pill = svg.querySelector(".pill")!;
    const body = svg.querySelector(".body")!;
    expect(body.getAttribute("height")).toBe("0");
    expect(Number(body.getAttribute("y"))).toBeLessThan(Number(pill.getAttribute("height")));
  });

  it("gives each toast its own filter id", () => {
    const hud = new Hud({ ...on });
    hud.push(entry());
    hud.push(entry({ id: 2 }));
    const ids = [...shadow()!.querySelectorAll(".toast filter")].map((f) => f.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("say() posts an agent narration", () => {
    const hud = new Hud({ ...on });
    hud.note("Connecting wallet", "clicking the modal");
    expect(shadow()!.querySelector(".toast .title")!.textContent).toBe(
      "Connecting wallet · waiting",
    );
    expect(shadow()!.querySelector(".row .detail")!.textContent).toBe("clicking the modal");
  });

  it("clear() empties both layers, destroy() removes the host", () => {
    const hud = new Hud({ ...on });
    hud.push(entry());
    hud.clear();
    expect(shadow()!.querySelectorAll(".row")).toHaveLength(0);
    expect(shadow()!.querySelector(".empty")).not.toBeNull();
    hud.destroy();
    expect(host()).toBeNull();
  });

  it("setOptions can turn parts off, and disabling tears it down", () => {
    const hud = new Hud({ ...on });
    hud.push(entry());
    hud.setOptions({ toasts: false, panel: true, position: "bottom-left" });
    const root = shadow()!.querySelector(".root") as HTMLElement;
    expect(root.dataset.pos).toBe("bottom-left");
    expect((shadow()!.querySelector(".toasts") as HTMLElement).style.display).toBe("none");
    hud.setOptions({ toasts: false, panel: false, position: "top-right" });
    expect(host()).toBeNull();
  });
});

describe("hud labels", () => {
  it("turns raw methods into what a wallet prompt would say", () => {
    expect(describeEntry(entry({ method: "eth_requestAccounts", result: "0xabc" })).title).toBe(
      "Connect",
    );
    expect(
      describeEntry(
        entry({
          decoded: {
            kind: "siwe",
            summary: "…",
            siwe: { domain: "app.example.com", nonce: "n1" },
          },
        }),
      ),
    ).toEqual({ title: "Sign-in (SIWE)", detail: "app.example.com · nonce n1" });
    expect(
      describeEntry(entry({ method: "eth_sendTransaction", decoded: { kind: "transaction", summary: "tx to 0x1" } })),
    ).toEqual({ title: "Transaction", detail: "tx to 0x1" });
  });
});

describe("hud does not confuse the URI scanner", () => {
  it("a wc: URI shown in the HUD is not reported as the page's URI", () => {
    clearWcUri();
    document.querySelectorAll(HUD_HOST).forEach((n) => n.remove());
    const uri = `wc:${"c".repeat(64)}@2?relayProtocol=irn&symKey=${"d".repeat(64)}`;
    const hud = new Hud({ ...on });
    hud.note("pairing", uri);
    expect(findWcUri()).toBeNull();
  });
});
