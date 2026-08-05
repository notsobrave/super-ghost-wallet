import { describe, expect, it } from "vitest";
import { stringToHex, verifyMessage, verifyTypedData } from "viem";
import { GhostProvider } from "../src/provider.js";
import { ProviderRpcError } from "../src/types.js";

const ANVIL0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ANVIL1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("accounts", () => {
  it("derives the well-known anvil accounts", () => {
    const p = new GhostProvider();
    expect(p.addresses[0]).toBe(ANVIL0);
    expect(p.addresses[1]).toBe(ANVIL1);
    expect(p.addresses).toHaveLength(10);
  });

  it("gates eth_accounts behind eth_requestAccounts", async () => {
    const p = new GhostProvider();
    expect(await p.request({ method: "eth_accounts" })).toEqual([]);
    expect(await p.request({ method: "eth_requestAccounts" })).toEqual([ANVIL0]);
    expect(await p.request({ method: "eth_accounts" })).toEqual([ANVIL0]);
  });

  it("autoConnect exposes accounts immediately", async () => {
    const p = new GhostProvider({ autoConnect: true });
    expect(await p.request({ method: "eth_accounts" })).toEqual([ANVIL0]);
  });

  it("switches accounts and emits accountsChanged", async () => {
    const p = new GhostProvider();
    await p.request({ method: "eth_requestAccounts" });
    const events: unknown[] = [];
    p.on("accountsChanged", (a) => events.push(a));
    p.useAccount(1);
    expect(p.activeAccount.address).toBe(ANVIL1);
    expect(events).toEqual([[ANVIL1]]);
  });
});

describe("signing", () => {
  it("personal_sign produces a signature that recovers the address", async () => {
    const p = new GhostProvider();
    const message = "Sign in to Example\nNonce: 12345";
    const sig = (await p.request({
      method: "personal_sign",
      params: [stringToHex(message), ANVIL0],
    })) as `0x${string}`;
    expect(
      await verifyMessage({ address: ANVIL0, message, signature: sig }),
    ).toBe(true);
  });

  it("personal_sign tolerates swapped [address, data] order", async () => {
    const p = new GhostProvider();
    const message = "hello";
    const sig = (await p.request({
      method: "personal_sign",
      params: [ANVIL0, stringToHex(message)],
    })) as `0x${string}`;
    expect(
      await verifyMessage({ address: ANVIL0, message, signature: sig }),
    ).toBe(true);
  });

  it("signs EIP-712 typed data (v4)", async () => {
    const p = new GhostProvider();
    const typed = {
      domain: { name: "Example", version: "1", chainId: 31337 },
      types: {
        Login: [
          { name: "user", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "Login",
      message: { user: ANVIL0, nonce: 7n },
    } as const;
    const sig = (await p.request({
      method: "eth_signTypedData_v4",
      params: [
        ANVIL0,
        JSON.stringify(typed, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
      ],
    })) as `0x${string}`;
    expect(
      await verifyTypedData({ ...typed, address: ANVIL0, signature: sig }),
    ).toBe(true);
  });

  it("signs with the account matching the requested address", async () => {
    const p = new GhostProvider();
    const message = "who signs?";
    const sig = (await p.request({
      method: "personal_sign",
      params: [stringToHex(message), ANVIL1],
    })) as `0x${string}`;
    expect(
      await verifyMessage({ address: ANVIL1, message, signature: sig }),
    ).toBe(true);
  });
});

describe("modes", () => {
  it("reject mode returns EIP-1193 4001", async () => {
    const p = new GhostProvider({ mode: "reject" });
    await expect(
      p.request({ method: "personal_sign", params: [stringToHex("x"), ANVIL0] }),
    ).rejects.toMatchObject({ code: 4001 });
    // Non-sensitive methods still work.
    expect(await p.request({ method: "eth_chainId" })).toBe("0x7a69");
  });

  it("queue mode parks requests until approve/deny", async () => {
    const p = new GhostProvider({ mode: "queue" });
    const inflight = p.request({
      method: "personal_sign",
      params: [stringToHex("queued"), ANVIL0],
    });
    await new Promise((r) => setTimeout(r, 10));
    const pending = p.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].method).toBe("personal_sign");
    p.approve(pending[0].id);
    const sig = (await inflight) as `0x${string}`;
    expect(
      await verifyMessage({ address: ANVIL0, message: "queued", signature: sig }),
    ).toBe(true);

    const denied = p.request({
      method: "personal_sign",
      params: [stringToHex("no"), ANVIL0],
    });
    denied.catch(() => {}); // avoid unhandled-rejection noise before assertion
    await new Promise((r) => setTimeout(r, 10));
    p.deny(p.pending()[0].id);
    await expect(denied).rejects.toMatchObject({ code: 4001 });
  });
});

describe("safety", () => {
  it("refuses mainnet chain ids by default", () => {
    expect(() => new GhostProvider({ chainId: 1 })).toThrow(/real-funds/);
    const p = new GhostProvider();
    expect(() => p.setChain(8453, "https://mainnet.base.org")).toThrow(
      /real-funds/,
    );
  });

  it("allows mainnet with the explicit override", () => {
    const p = new GhostProvider({ chainId: 1, allowMainnet: true });
    expect(p.config.chainId).toBe(1);
  });

  it("refuses switching to a chain with no RPC url", () => {
    const p = new GhostProvider();
    expect(() => p.setChain(11155111)).toThrow(ProviderRpcError);
  });
});

describe("log", () => {
  it("records sensitive requests with status and result", async () => {
    const p = new GhostProvider();
    await p.request({ method: "eth_requestAccounts" });
    await p.request({
      method: "personal_sign",
      params: [stringToHex("logged"), ANVIL0],
    });
    const log = p.getLog();
    expect(log.map((e) => [e.method, e.status])).toEqual([
      ["eth_requestAccounts", "approved"],
      ["personal_sign", "approved"],
    ]);
    // eth_chainId is not sensitive -> not logged
    await p.request({ method: "eth_chainId" });
    expect(p.getLog()).toHaveLength(2);
  });
});
