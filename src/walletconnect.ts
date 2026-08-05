import * as SignClientModule from "@walletconnect/sign-client";
import type SignClientInstance from "@walletconnect/sign-client";

/**
 * ESM/CJS interop: the package ships CJS behind an ESM wrapper, so under Node
 * ESM the default export is a namespace object and `SignClient.init` is
 * undefined. The callable class lives on the named export (or one level
 * deeper under bundlers) — resolve it once here.
 */
const SignClient = ((SignClientModule as Record<string, unknown>).SignClient ??
  (SignClientModule as { default?: { default?: unknown } }).default?.default ??
  SignClientModule.default) as {
  init(options: Record<string, unknown>): Promise<SignClientInstance>;
};
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { hexToString, isAddress, isHex, type Hex } from "viem";
import { deriveSolanaAccounts, solSign } from "./solana.js";
import { base58 } from "@scure/base";
import { DEFAULT_MNEMONIC, type Mode } from "./types.js";

/**
 * The "phone" side of the wallet: a WalletConnect v2 peer that pairs from a
 * `wc:` URI — exactly what a mobile wallet does after scanning the QR code a
 * dApp shows. Runs in Node (a real remote wallet is a separate process), not
 * in the extension.
 *
 * Test keys only: same anvil mnemonic and the same mainnet refusal as the
 * injected provider.
 */

export interface RemoteWalletOptions {
  /** WalletConnect Cloud project id (dApp and wallet must share a relay). */
  projectId: string;
  mnemonic?: string;
  privateKeys?: `0x${string}`[];
  accountIndex?: number;
  /** EVM chains to advertise, CAIP-2 (default: sepolia + anvil). */
  chains?: string[];
  /** Solana chains to advertise, CAIP-2. */
  solanaChains?: string[];
  mode?: Mode;
  /** Milliseconds to wait before answering — models a human reaching for their phone. */
  delayMs?: number;
  walletName?: string;
  relayUrl?: string;
  /**
   * Namespaces this wallet's WalletConnect storage. Two clients in ONE process
   * (e.g. a dApp-side client and this wallet inside the same test) otherwise
   * share Core state and misroute pairings. A real phone is its own process,
   * so the default is fine outside that case.
   */
  storagePrefix?: string;
  /** Called on every handled request; mirrors the injected provider's log. */
  onRequest?: (entry: RemoteLogEntry) => void;
}

export interface RemoteLogEntry {
  topic: string;
  chainId: string;
  method: string;
  params: unknown;
  status: "approved" | "rejected";
  /** UTF-8 decode of what was signed, when applicable. */
  decoded?: string;
  result?: unknown;
}

const DEFAULT_CHAINS = ["eip155:11155111", "eip155:31337"];
const MAINNET_CAIP = new Set([
  "eip155:1",
  "eip155:10",
  "eip155:56",
  "eip155:137",
  "eip155:8453",
  "eip155:42161",
  "eip155:43114",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
]);

const EVM_METHODS = [
  "personal_sign",
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
  "eth_signTransaction",
];
const SOLANA_METHODS = ["solana_signMessage", "solana_signTransaction"];

const USER_REJECTED = { code: 4001, message: "Super Ghost Wallet: user rejected the request" };

/**
 * A remote (QR-paired) wallet. `pair(uri)` consumes the URI a dApp's
 * connect-modal QR encodes; from then on it approves sessions and signs.
 */
export class RemoteWallet {
  private client!: SignClientInstance;
  private opts: Required<Omit<RemoteWalletOptions, "onRequest" | "privateKeys" | "relayUrl">> &
    Pick<RemoteWalletOptions, "onRequest" | "privateKeys" | "relayUrl">;
  private evmAccount: ReturnType<typeof mnemonicToAccount> | ReturnType<typeof privateKeyToAccount>;
  private solanaAccount: ReturnType<typeof deriveSolanaAccounts>[number];
  readonly log: RemoteLogEntry[] = [];
  /** Resolves with the session once a dApp completes the pairing. */
  private sessionResolvers: ((session: unknown) => void)[] = [];

  constructor(options: RemoteWalletOptions) {
    const chains = options.chains ?? DEFAULT_CHAINS;
    for (const c of [...chains, ...(options.solanaChains ?? [])])
      if (MAINNET_CAIP.has(c))
        throw new Error(
          `super-ghost-wallet: ${c} is a real-funds network — remote wallet is test-keys only`,
        );
    this.opts = {
      projectId: options.projectId,
      mnemonic: options.mnemonic ?? DEFAULT_MNEMONIC,
      privateKeys: options.privateKeys,
      accountIndex: options.accountIndex ?? 0,
      chains,
      solanaChains: options.solanaChains ?? [],
      mode: options.mode ?? "auto",
      delayMs: options.delayMs ?? 0,
      walletName: options.walletName ?? "Super Ghost Wallet (remote)",
      relayUrl: options.relayUrl,
      storagePrefix: options.storagePrefix ?? "sgw",
      onRequest: options.onRequest,
    };
    const index = this.opts.accountIndex;
    this.evmAccount = options.privateKeys?.length
      ? privateKeyToAccount(options.privateKeys[0])
      : mnemonicToAccount(this.opts.mnemonic, { addressIndex: index });
    this.solanaAccount = deriveSolanaAccounts(this.opts.mnemonic, index + 1)[index];
  }

  get address(): string {
    return this.evmAccount.address;
  }

  get solanaAddress(): string {
    return this.solanaAccount.address;
  }

  async init() {
    this.client = await SignClient.init({
      projectId: this.opts.projectId,
      relayUrl: this.opts.relayUrl,
      customStoragePrefix: this.opts.storagePrefix,
      metadata: {
        name: this.opts.walletName,
        description: "Headless test wallet — pairs from a WalletConnect QR code",
        url: "https://github.com/notsobrave/super-ghost-wallet",
        icons: [],
      },
    });
    this.client.on("session_proposal", (proposal) =>
      void this.onProposal(proposal as unknown as { id: number; params: unknown }),
    );
    this.client.on("session_request", (event) => void this.onRequest(event));
    return this;
  }

  /** Consume a `wc:` URI — the payload a dApp's QR code encodes. */
  async pair(uri: string) {
    if (!uri.startsWith("wc:"))
      throw new Error(`super-ghost-wallet: not a WalletConnect URI: ${uri.slice(0, 24)}…`);
    const session = new Promise((resolve) => this.sessionResolvers.push(resolve));
    await this.client.core.pairing.pair({ uri });
    return session;
  }

  async disconnect() {
    for (const s of this.client.session.getAll())
      await this.client
        .disconnect({ topic: s.topic, reason: { code: 6000, message: "User disconnected" } })
        .catch(() => {});
  }

  async close() {
    await this.disconnect();
    await this.client.core.relayer.transportClose().catch(() => {});
  }

  /* ── session approval ─────────────────────────────────────────────── */

  private caipAccounts(chains: string[], address: string) {
    return chains.map((c) => `${c}:${address}`);
  }

  private async onProposal(proposal: { id: number; params: unknown }) {
    if (this.opts.mode === "reject") {
      await this.client.reject({ id: proposal.id, reason: USER_REJECTED });
      return;
    }
    await this.wait();
    type NsSpec = { chains?: string[]; methods?: string[]; events?: string[] };
    const params = proposal.params as {
      requiredNamespaces?: Record<string, NsSpec>;
      optionalNamespaces?: Record<string, NsSpec>;
    };
    const namespaces: Record<string, unknown> = {};
    const wanted: Record<string, NsSpec> = {
      ...(params.optionalNamespaces ?? {}),
      ...(params.requiredNamespaces ?? {}),
    };
    for (const [key, spec] of Object.entries(wanted)) {
      const isSolana = key === "solana";
      const advertise = isSolana ? this.opts.solanaChains : this.opts.chains;
      // Intersect what the dApp asks for with what we're configured for; if the
      // dApp names chains we don't advertise, accept them anyway unless mainnet
      // (a wallet that refuses the required chain kills the pairing outright).
      const chains = (spec.chains ?? []).filter((c) => !MAINNET_CAIP.has(c));
      const useChains = chains.length ? chains : advertise;
      if (!useChains.length) continue;
      namespaces[key] = {
        chains: useChains,
        accounts: this.caipAccounts(
          useChains,
          isSolana ? this.solanaAddress : this.address,
        ),
        methods: spec.methods ?? (isSolana ? SOLANA_METHODS : EVM_METHODS),
        events: spec.events ?? ["accountsChanged", "chainChanged"],
      };
    }

    const { acknowledged } = await this.client.approve({
      id: proposal.id,
      namespaces: namespaces as never,
    });
    const session = await acknowledged();
    for (const r of this.sessionResolvers.splice(0)) r(session);
  }

  /* ── request signing ──────────────────────────────────────────────── */

  private wait() {
    return this.opts.delayMs
      ? new Promise((r) => setTimeout(r, this.opts.delayMs))
      : Promise.resolve();
  }

  private async onRequest(event: {
    topic: string;
    id: number;
    params: { request: { method: string; params: unknown }; chainId: string };
  }) {
    const { topic, id } = event;
    const { method, params } = event.params.request;
    const entry: RemoteLogEntry = {
      topic,
      chainId: event.params.chainId,
      method,
      params,
      status: "approved",
    };
    try {
      if (this.opts.mode === "reject") throw USER_REJECTED;
      await this.wait();
      const result = await this.handle(method, params, entry);
      entry.result = result;
      this.log.push(entry);
      this.opts.onRequest?.(entry);
      await this.client.respond({ topic, response: { id, jsonrpc: "2.0", result } });
    } catch (err) {
      entry.status = "rejected";
      this.log.push(entry);
      this.opts.onRequest?.(entry);
      const error = (err as { code?: number })?.code
        ? (err as { code: number; message: string })
        : { code: -32603, message: (err as Error)?.message ?? "wallet error" };
      await this.client.respond({ topic, response: { id, jsonrpc: "2.0", error } });
    }
  }

  private async handle(method: string, params: unknown, entry: RemoteLogEntry) {
    const list = (params ?? []) as unknown[];
    switch (method) {
      case "personal_sign": {
        const data = list.find(
          (p): p is string => typeof p === "string" && !isAddress(p, { strict: false }),
        );
        const text = isHex(data ?? "") ? hexToString(data as Hex) : String(data);
        entry.decoded = text;
        return this.evmAccount.signMessage({ message: text });
      }
      case "eth_signTypedData":
      case "eth_signTypedData_v4": {
        const json = list.find((p) => typeof p === "object" || (typeof p === "string" && p.startsWith("{")));
        const typed = typeof json === "string" ? JSON.parse(json) : json;
        entry.decoded = `EIP-712 ${typed?.primaryType ?? "?"}`;
        return this.evmAccount.signTypedData(typed);
      }
      case "solana_signMessage": {
        const p = list[0] as { message?: string } | undefined;
        const bytes = p?.message ? base58.decode(p.message) : new Uint8Array();
        entry.decoded = new TextDecoder().decode(bytes);
        return { signature: base58.encode(solSign(bytes, this.solanaAccount)) };
      }
      default:
        throw { code: 4200, message: `super-ghost-wallet: ${method} not supported over WalletConnect yet` };
    }
  }
}

/** Convenience: build, init, and pair in one call. */
export async function pairRemoteWallet(uri: string, options: RemoteWalletOptions) {
  const wallet = await new RemoteWallet(options).init();
  await wallet.pair(uri);
  return wallet;
}
