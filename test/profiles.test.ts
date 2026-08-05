import { describe, expect, it } from "vitest";
import { stringToHex, verifyMessage } from "viem";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { GhostProvider } from "../src/provider.js";
import { buildControlApi } from "../src/control.js";

const ANVIL0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("generateWallet", () => {
  it("produces a valid random mnemonic with fresh EVM + Solana accounts", async () => {
    const p = new GhostProvider();
    const before = p.addresses[0];
    const w = p.generateWallet(3);
    expect(validateMnemonic(w.mnemonic, wordlist)).toBe(true);
    expect(w.addresses).toHaveLength(3);
    expect(w.solanaAddresses).toHaveLength(3);
    expect(w.addresses[0]).not.toBe(before);
    // the new identity actually signs
    const sig = (await p.request({
      method: "personal_sign",
      params: [stringToHex("fresh"), w.addresses[0]],
    })) as `0x${string}`;
    expect(
      await verifyMessage({
        address: w.addresses[0] as `0x${string}`,
        message: "fresh",
        signature: sig,
      }),
    ).toBe(true);
  });

  it("is different every call and never leaks the mnemonic via getState", () => {
    const p = new GhostProvider();
    const api = buildControlApi(p);
    const a = api.generateWallet(1);
    const b = api.generateWallet(1);
    expect(a.mnemonic).not.toBe(b.mnemonic);
    const state = api.getState() as Record<string, unknown>;
    expect(state).not.toHaveProperty("mnemonic");
    expect(state).not.toHaveProperty("privateKeys");
    expect(state.activeAccount).toBe(b.addresses[0]);
  });
});

describe("hardware-wallet profile (ledger)", () => {
  it("adds a device-confirmation delay to sensitive requests", async () => {
    const p = new GhostProvider({ profile: "ledger" });
    const t0 = Date.now();
    await p.request({ method: "personal_sign", params: [stringToHex("x"), ANVIL0] });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    // reads stay instant
    const t1 = Date.now();
    await p.request({ method: "eth_chainId" });
    expect(Date.now() - t1).toBeLessThan(100);
  }, 10_000);

  it("explicit delayMs overrides the profile default", async () => {
    const p = new GhostProvider({ profile: "ledger", delayMs: 50 });
    const t0 = Date.now();
    await p.request({ method: "personal_sign", params: [stringToHex("x"), ANVIL0] });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("blind signing off rejects typed data and calldata like a real device", async () => {
    const p = new GhostProvider({ profile: "ledger", blindSigning: false, delayMs: 1 });
    await expect(
      p.request({
        method: "eth_signTypedData_v4",
        params: [ANVIL0, JSON.stringify({ primaryType: "Permit", domain: {}, types: {}, message: {} })],
      }),
    ).rejects.toThrow(/0x6985|Blind signing/);
    await expect(
      p.request({
        method: "eth_sendTransaction",
        params: [{ from: ANVIL0, to: ANVIL0, data: "0xa9059cbb" }],
      }),
    ).rejects.toThrow(/0x6985|Blind signing/);
    // a plain value transfer needs no blind signing (it fails later, on RPC)
    await expect(
      p.request({ method: "personal_sign", params: [stringToHex("plain"), ANVIL0] }),
    ).resolves.toMatch(/^0x/);
  });

  it("enableBlindSigning unblocks typed data", async () => {
    const p = new GhostProvider({ profile: "ledger", blindSigning: false, delayMs: 1 });
    const api = buildControlApi(p);
    api.enableBlindSigning();
    await expect(
      p.request({
        method: "eth_signTypedData_v4",
        params: [
          ANVIL0,
          JSON.stringify({
            primaryType: "Login",
            domain: { name: "X" },
            types: { Login: [{ name: "user", type: "address" }] },
            message: { user: ANVIL0 },
          }),
        ],
      }),
    ).resolves.toMatch(/^0x/);
  });

  it("setProfile('ledger') turns blind signing off by default", () => {
    const api = buildControlApi(new GhostProvider());
    api.setProfile("ledger");
    expect((api.getState() as Record<string, unknown>).blindSigning).toBe(false);
    api.setProfile(null);
    expect((api.getState() as Record<string, unknown>).profile).toBe(null);
  });
});

describe("impersonation", () => {
  it("swaps the announced identity and the isMetaMask flag", () => {
    const p = new GhostProvider();
    expect(p.identity().name).toBe("Super Ghost Wallet");
    expect(p.isMetaMask).toBe(false);

    const api = buildControlApi(p);
    expect(api.impersonate("metamask")).toMatchObject({
      name: "MetaMask",
      rdns: "io.metamask",
      isMetaMask: true,
    });
    expect(p.isMetaMask).toBe(true);

    expect(api.impersonate("phantom")).toMatchObject({ name: "Phantom", rdns: "app.phantom" });
    expect(p.isMetaMask).toBe(false);

    api.impersonate(null);
    expect(p.identity().name).toBe("Super Ghost Wallet");
  });
});
