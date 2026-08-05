import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { GhostProvider } from "../src/provider.js";
import {
  buildSiwsMessage,
  deriveSolanaAccounts,
  registerSolanaWallet,
  signSolanaTransaction,
  slip10Internals,
} from "../src/solana.js";
import { DEFAULT_MNEMONIC } from "../src/types.js";

/**
 * First Solana account for the anvil/hardhat test mnemonic at m/44'/501'/0'/0'
 * — the path Phantom/Solflare use. The derivation itself is pinned against the
 * official SLIP-0010 ed25519 test vectors below.
 */
const SOL0 = "oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96";

describe("slip-0010 conformance", () => {
  // Official SLIP-0010 ed25519 test vector 1 (seed 000102…0f). Guards the
  // derivation itself: if these drift, every derived address is wrong.
  it("matches the published private keys for m and m/0'", () => {
    const seed = Uint8Array.from(
      "000102030405060708090a0b0c0d0e0f".match(/../g)!.map((h) => parseInt(h, 16)),
    );
    const { master, child } = slip10Internals();
    const m = master(seed);
    expect(Buffer.from(m.key).toString("hex")).toBe(
      "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7",
    );
    expect(Buffer.from(child(m, 0).key).toString("hex")).toBe(
      "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
    );
  });
});

describe("solana derivation", () => {
  it("derives Phantom-compatible addresses from the mnemonic", () => {
    const accounts = deriveSolanaAccounts(DEFAULT_MNEMONIC, 3);
    expect(accounts).toHaveLength(3);
    // base58 pubkeys, 32 bytes each, deterministic
    for (const a of accounts) {
      expect(base58.decode(a.address)).toHaveLength(32);
      expect(a.publicKey).toEqual(ed25519.getPublicKey(a.secretKey));
    }
    expect(accounts[0].address).toBe(SOL0);
    expect(new Set(accounts.map((a) => a.address)).size).toBe(3);
  });

  it("exposes solana accounts on the provider alongside EVM ones", () => {
    const p = new GhostProvider();
    expect(p.solanaAddresses[0]).toBe(SOL0);
    expect(p.activeSolanaAccount.address).toBe(SOL0);
    p.useAccount(1);
    expect(p.activeSolanaAccount.address).toBe(p.solanaAddresses[1]);
  });
});

describe("solana signing", () => {
  it("signs messages verifiably", async () => {
    const p = new GhostProvider();
    const message = new TextEncoder().encode("gm solana");
    const { signature } = (await p.request({
      method: "solana_signMessage",
      params: [message],
    })) as { signature: Uint8Array };
    expect(
      ed25519.verify(signature, message, p.activeSolanaAccount.publicKey),
    ).toBe(true);
  });

  it("signs SIWS sign-in and returns the exact signed bytes", async () => {
    const p = new GhostProvider();
    const r = (await p.request({
      method: "solana_signIn",
      params: [{ domain: "app.example.com", statement: "Sign in.", nonce: "abc123" }],
    })) as { signedMessage: Uint8Array; signature: Uint8Array };
    const text = new TextDecoder().decode(r.signedMessage);
    expect(text).toContain("app.example.com wants you to sign in with your Solana account:");
    expect(text).toContain(p.activeSolanaAccount.address);
    expect(text).toContain("Nonce: abc123");
    expect(
      ed25519.verify(r.signature, r.signedMessage, p.activeSolanaAccount.publicKey),
    ).toBe(true);
  });

  it("builds SIWS messages to the spec layout", () => {
    const msg = buildSiwsMessage(
      { statement: "Hi", uri: "https://x.io", version: "1", nonce: "n1" },
      "x.io",
      SOL0,
    );
    expect(msg.split("\n")).toEqual([
      "x.io wants you to sign in with your Solana account:",
      SOL0,
      "",
      "Hi",
      "",
      "URI: https://x.io",
      "Version: 1",
      "Nonce: n1",
    ]);
  });

  it("splices the signature into the right slot of a transaction", () => {
    const account = deriveSolanaAccounts(DEFAULT_MNEMONIC, 1)[0];
    // 1 signature slot, header(3), 1 static key = our pubkey, then filler.
    const tx = new Uint8Array(1 + 64 + 3 + 1 + 32 + 8);
    tx[0] = 1; // shortvec: one signature
    tx[65] = 1; // numRequiredSignatures
    tx[68] = 1; // shortvec: one account key
    tx.set(account.publicKey, 69);
    const { signedTransaction, signature } = signSolanaTransaction(tx, account);
    expect(signedTransaction.slice(1, 65)).toEqual(signature);
    expect(ed25519.verify(signature, tx.slice(65), account.publicKey)).toBe(true);
  });

  it("refuses to sign a transaction it is not a signer of", () => {
    const [mine, other] = deriveSolanaAccounts(DEFAULT_MNEMONIC, 2);
    const tx = new Uint8Array(1 + 64 + 3 + 1 + 32 + 8);
    tx[0] = 1;
    tx[65] = 1;
    tx[68] = 1;
    tx.set(other.publicKey, 69);
    expect(() => signSolanaTransaction(tx, mine)).toThrow(/not a required signer/);
  });

  it("refuses solana mainnet without the explicit override", () => {
    expect(() => new GhostProvider({ solanaCluster: "mainnet" })).toThrow(/real-funds/);
    expect(
      new GhostProvider({ solanaCluster: "mainnet", allowMainnet: true }).config.solanaCluster,
    ).toBe("mainnet");
  });
});

describe("wallet standard adapter", () => {
  it("exposes the solana features and routes them through the provider", async () => {
    const p = new GhostProvider();
    const wallet = registerSolanaWallet({
      request: (args) => p.request(args),
      solanaAccount: () => p.activeSolanaAccount,
      solanaChain: () => `solana:${p.config.solanaCluster}`,
      walletName: () => p.identity().name,
      walletIcon: () => "icon",
    });
    expect(Object.keys(wallet.features)).toEqual(
      expect.arrayContaining([
        "standard:connect",
        "standard:disconnect",
        "solana:signMessage",
        "solana:signTransaction",
        "solana:signAndSendTransaction",
        "solana:signIn",
      ]),
    );
    const { accounts } = await wallet.features["standard:connect"].connect();
    expect(accounts[0].address).toBe(SOL0);
    expect(wallet.chains).toEqual(["solana:devnet"]);

    const message = new TextEncoder().encode("standard");
    const [signed] = await wallet.features["solana:signMessage"].signMessage({
      account: accounts[0],
      message,
    });
    expect(
      ed25519.verify(signed.signature, message, p.activeSolanaAccount.publicKey),
    ).toBe(true);
  });

  it("reports the impersonated name", () => {
    const p = new GhostProvider({ impersonate: "phantom" });
    const wallet = registerSolanaWallet({
      request: (a) => p.request(a),
      solanaAccount: () => p.activeSolanaAccount,
      solanaChain: () => "solana:devnet",
      walletName: () => p.identity().name,
      walletIcon: () => "icon",
    });
    expect(wallet.name).toBe("Phantom");
  });
});
