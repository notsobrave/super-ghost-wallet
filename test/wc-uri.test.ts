// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { clearWcUri, findWcUri, installClipboardHook } from "../src/control.js";

const URI = `wc:${"a".repeat(64)}@2?relayProtocol=irn&symKey=${"b".repeat(64)}`;

describe("WalletConnect URI discovery", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    clearWcUri();
  });

  it("returns null when the page shows no QR", () => {
    document.body.innerHTML = "<div>connect your wallet</div>";
    expect(findWcUri()).toBeNull();
  });

  it("finds the URI in an attribute (AppKit-style QR element)", () => {
    document.body.innerHTML = `<wui-qr-code uri="${URI}"></wui-qr-code>`;
    expect(findWcUri()).toBe(URI);
  });

  it("pierces shadow DOM (RainbowKit / AppKit render there)", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const inner = document.createElement("div");
    const deep = inner.attachShadow({ mode: "open" });
    deep.innerHTML = `<canvas data-uri="${URI}"></canvas>`;
    shadow.append(inner);
    expect(findWcUri()).toBe(URI);
  });

  it("captures the URI a modal copies to the clipboard", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void writes.push(t) },
    });
    installClipboardHook();
    await navigator.clipboard.writeText(URI);
    expect(writes).toEqual([URI]); // still forwarded to the real clipboard
    expect(findWcUri()).toBe(URI);
  });

  it("ignores strings that merely look like a URI", () => {
    document.body.innerHTML = `<div data-x="wc:short@2?x=1"></div>`;
    expect(findWcUri()).toBeNull();
  });
});
