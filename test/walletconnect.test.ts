import { describe, expect, it } from "vitest";
import { RemoteWallet } from "../src/walletconnect.js";

const PROJECT_ID = process.env.SGW_WC_PROJECT_ID;

/** Just the slice of the dApp-side SignClient this test drives. */
interface DappClient {
  connect(o: Record<string, unknown>): Promise<{
    uri?: string;
    approval: () => Promise<{ topic: string; namespaces: Record<string, { accounts: string[] }> }>;
  }>;
  request(o: Record<string, unknown>): Promise<unknown>;
  core: { relayer: { transportClose(): Promise<void> } };
}

describe("remote wallet (WalletConnect)", () => {
  it("derives the same test identity as the injected provider", () => {
    const w = new RemoteWallet({ projectId: "x" });
    expect(w.address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(w.solanaAddress).toBe("oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96");
    expect(new RemoteWallet({ projectId: "x", accountIndex: 1 }).address).toBe(
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
  });

  it("refuses real-funds chains at construction", () => {
    expect(() => new RemoteWallet({ projectId: "x", chains: ["eip155:1"] })).toThrow(
      /real-funds/,
    );
    expect(
      () => new RemoteWallet({ projectId: "x", solanaChains: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] }),
    ).toThrow(/real-funds/);
  });

  it("rejects a non-WalletConnect URI", async () => {
    const w = new RemoteWallet({ projectId: "x" });
    await expect(w.pair("https://not-a-wc-uri")).rejects.toThrow(/not a WalletConnect URI/);
  });
});

/**
 * Full pairing round-trip over the real relay: a dApp-side SignClient emits the
 * URI a QR code would carry, the wallet pairs with it and signs. Needs network
 * plus a project id, so it is opt-in.
 */
describe.skipIf(!PROJECT_ID)("pairing round-trip (live relay)", () => {
  it("pairs from a wc: URI and signs personal_sign", async () => {
    // Same ESM/CJS interop dance as src/walletconnect.ts.
    const WC = (await import("@walletconnect/sign-client")) as unknown as {
      SignClient?: unknown;
      default?: { default?: unknown };
    };
    const SignClient = (WC.SignClient ?? WC.default?.default ?? WC.default) as {
      init(o: Record<string, unknown>): Promise<DappClient>;
    };
    const { verifyMessage } = await import("viem");

    const dapp = await SignClient.init({
      projectId: PROJECT_ID!,
      customStoragePrefix: "sgw-test-dapp",
      metadata: {
        name: "sgw test dapp",
        description: "pairing round-trip",
        url: "https://example.com",
        icons: [],
      },
    });
    const wallet = await new RemoteWallet({
      projectId: PROJECT_ID!,
      // dApp and wallet share this process — isolate their WC storage.
      storagePrefix: "sgw-test-wallet",
    }).init();

    const { uri, approval } = await dapp.connect({
      optionalNamespaces: {
        eip155: {
          chains: ["eip155:11155111"],
          methods: ["personal_sign"],
          events: ["accountsChanged"],
        },
      },
    });
    expect(uri).toMatch(/^wc:[0-9a-f]{64}@2\?/);

    await wallet.pair(uri!);
    const session = await approval();
    expect(session.namespaces.eip155.accounts[0]).toContain(wallet.address);

    const message = "signed over the relay";
    const signature = (await dapp.request({
      topic: session.topic,
      chainId: "eip155:11155111",
      request: { method: "personal_sign", params: [message, wallet.address] },
    })) as `0x${string}`;

    expect(
      await verifyMessage({
        address: wallet.address as `0x${string}`,
        message,
        signature,
      }),
    ).toBe(true);
    expect(wallet.log.at(-1)).toMatchObject({
      method: "personal_sign",
      status: "approved",
      decoded: message,
    });

    await wallet.close();
    await dapp.core.relayer.transportClose().catch(() => {});
  }, 60_000);
});
