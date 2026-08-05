import { describe, expect, it } from "vitest";
import { stringToHex } from "viem";
import { GhostProvider } from "../src/provider.js";
import { decodePersonalSign, decodeTypedData } from "../src/decode.js";
import type { SgwEvent } from "../src/types.js";

const ANVIL0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const sign = (p: GhostProvider, msg = "hello") =>
  p.request({ method: "personal_sign", params: [stringToHex(msg), ANVIL0] });

describe("per-method policies", () => {
  it("policy overrides the global mode", async () => {
    const p = new GhostProvider({ mode: "auto", policies: { personal_sign: "reject" } });
    await expect(sign(p)).rejects.toMatchObject({ code: 4001 });
    // other sensitive methods still follow the global mode
    expect(await p.request({ method: "eth_requestAccounts" })).toEqual([ANVIL0]);
  });

  it("auto policy carves an exception out of global reject", async () => {
    const p = new GhostProvider({ mode: "reject", policies: { personal_sign: "auto" } });
    expect(await sign(p)).toMatch(/^0x/);
    await expect(p.request({ method: "eth_requestAccounts" })).rejects.toMatchObject({
      code: 4001,
    });
  });
});

describe("failNext error injection", () => {
  it("fails exactly once with the injected code, then recovers", async () => {
    const p = new GhostProvider();
    p.failNext("personal_sign", 4902, "nope");
    await expect(sign(p)).rejects.toMatchObject({ code: 4902, message: "nope" });
    expect(await sign(p)).toMatch(/^0x/);
  });

  it('"*" matches any sensitive method', async () => {
    const p = new GhostProvider();
    p.failNext("*", 4900);
    await expect(p.request({ method: "eth_requestAccounts" })).rejects.toMatchObject({
      code: 4900,
    });
    // non-sensitive methods are not intercepted by "*"
    p.failNext("*", 4900);
    expect(await p.request({ method: "eth_chainId" })).toBe("0x7a69");
  });
});

describe("delay mode", () => {
  it("delays sensitive requests by delayMs", async () => {
    const p = new GhostProvider({ delayMs: 80 });
    const t0 = Date.now();
    await sign(p);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
    // non-sensitive requests stay instant
    const t1 = Date.now();
    await p.request({ method: "eth_chainId" });
    expect(Date.now() - t1).toBeLessThan(50);
  });
});

describe("waitForRequest", () => {
  it("resolves with the settled log entry", async () => {
    const p = new GhostProvider();
    const waiting = p.waitForRequest("personal_sign");
    await sign(p, "sync me");
    const entry = await waiting;
    expect(entry.method).toBe("personal_sign");
    expect(entry.status).toBe("approved");
    expect(entry.decoded?.summary).toBe("sync me");
  });

  it("also resolves on rejection, and '*' matches anything", async () => {
    const p = new GhostProvider({ mode: "reject" });
    const waiting = p.waitForRequest("*");
    await sign(p).catch(() => {});
    expect((await waiting).status).toBe("rejected");
  });
});

describe("events", () => {
  it("emits request + settled through onEvent", async () => {
    const events: SgwEvent[] = [];
    const p = new GhostProvider({}, () => {}, (e) => events.push(e));
    await sign(p);
    expect(events.map((e) => e.type)).toEqual(["request", "settled"]);
    expect(events[1].status).toBe("approved");
  });
});

describe("log decoding", () => {
  it("detects SIWE messages and extracts fields", () => {
    const msg = [
      "app.example.com wants you to sign in with your Ethereum account:",
      ANVIL0,
      "",
      "Prove ownership of this wallet.",
      "",
      "URI: https://app.example.com",
      "Version: 1",
      "Chain ID: 1",
      "Nonce: abc12345",
      "Issued At: 2026-08-05T12:00:00.000Z",
    ].join("\n");
    const d = decodePersonalSign([stringToHex(msg), ANVIL0]);
    expect(d?.kind).toBe("siwe");
    expect(d?.siwe).toMatchObject({
      domain: "app.example.com",
      address: ANVIL0,
      statement: "Prove ownership of this wallet.",
      chainId: 1,
      nonce: "abc12345",
    });
  });

  it("decodes plain utf8 messages and typed data", () => {
    expect(decodePersonalSign([stringToHex("gm"), ANVIL0])).toMatchObject({
      kind: "message",
      summary: "gm",
    });
    const d = decodeTypedData([
      ANVIL0,
      JSON.stringify({ primaryType: "Permit", domain: { name: "USDC" }, types: {}, message: {} }),
    ]);
    expect(d).toMatchObject({ kind: "typed-data", summary: "EIP-712 Permit @ USDC" });
  });

  it("attaches decoded summaries to log entries", async () => {
    const p = new GhostProvider();
    await sign(p, "logged text");
    expect(p.getLog().at(-1)?.decoded?.summary).toBe("logged text");
  });
});

describe("simulations", () => {
  it("simulateDisconnect emits disconnect + empty accountsChanged", async () => {
    const p = new GhostProvider();
    await p.request({ method: "eth_requestAccounts" });
    const got: Record<string, unknown> = {};
    p.on("accountsChanged", (a) => (got.accounts = a));
    p.on("disconnect", (e) => (got.disconnect = e));
    p.simulateDisconnect();
    expect(got.accounts).toEqual([]);
    expect(got.disconnect).toMatchObject({ code: 4900 });
    expect(await p.request({ method: "eth_accounts" })).toEqual([]);
  });

  it("simulateChainChanged re-emits the current chain", () => {
    const p = new GhostProvider();
    let chain: unknown;
    p.on("chainChanged", (c) => (chain = c));
    p.simulateChainChanged();
    expect(chain).toBe("0x7a69");
  });
});
