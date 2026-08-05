export type Mode = "auto" | "reject" | "queue";

export interface GhostConfig {
  /** BIP-39 mnemonic used to derive test accounts. */
  mnemonic: string;
  /** Extra raw private keys appended after mnemonic-derived accounts. */
  privateKeys: `0x${string}`[];
  /** How many accounts to derive from the mnemonic. */
  accountCount: number;
  /** Index of the currently active account. */
  accountIndex: number;
  chainId: number;
  /** chainId (decimal string) -> RPC url. */
  rpcUrls: Record<string, string>;
  mode: Mode;
  /** Per-method overrides of `mode` (e.g. { eth_sendTransaction: "reject" }). */
  policies: Record<string, Mode>;
  /** Milliseconds to wait before resolving sensitive requests (spinner testing). */
  delayMs: number;
  /** Refuse well-known mainnet chain ids unless true. */
  allowMainnet: boolean;
  /** If true, eth_accounts returns accounts before eth_requestAccounts. */
  autoConnect: boolean;
  /** Solana cluster the wallet reports/signs for. */
  solanaCluster: "devnet" | "testnet" | "localnet" | "mainnet";
  /** cluster -> RPC url. */
  solanaRpcUrls: Record<string, string>;
  /** Present as another wallet ("metamask" | "phantom") for dApps with hardcoded lists. */
  impersonate: "metamask" | "phantom" | null;
  /**
   * Behavioral profile: "ledger" simulates a hardware wallet (multi-second
   * device confirmation, blind-signing disabled by default), "mobile" a
   * slower remote signer. null = instant.
   */
  profile: "ledger" | "mobile" | null;
  /** Ledger profile: allow EIP-712 / calldata signing (device setting). */
  blindSigning: boolean;
  /** In-page toasts announcing each wallet action (for humans watching). */
  hudToasts: boolean;
  /** In-page side panel holding the full request log. */
  hudPanel: boolean;
  hudPosition: "top-right" | "bottom-right" | "top-left" | "bottom-left";
}

export const PROFILE_DELAYS: Record<string, number> = {
  ledger: 3000,
  mobile: 1200,
};

/** Anvil / Hardhat well-known dev mnemonic. Test keys only — never real funds. */
export const DEFAULT_MNEMONIC =
  "test test test test test test test test test test test junk";

export const DEFAULT_CONFIG: GhostConfig = {
  mnemonic: DEFAULT_MNEMONIC,
  privateKeys: [],
  accountCount: 10,
  accountIndex: 0,
  chainId: 31337,
  rpcUrls: { "31337": "http://127.0.0.1:8545" },
  mode: "auto",
  policies: {},
  delayMs: 0,
  allowMainnet: false,
  autoConnect: false,
  solanaCluster: "devnet",
  solanaRpcUrls: {
    devnet: "https://api.devnet.solana.com",
    testnet: "https://api.testnet.solana.com",
    localnet: "http://127.0.0.1:8899",
    mainnet: "https://api.mainnet-beta.solana.com",
  },
  impersonate: null,
  profile: null,
  blindSigning: true,
  // Off by default: an overlay must never surprise an existing test suite.
  hudToasts: false,
  hudPanel: false,
  hudPosition: "top-right",
};

/** Chains super-ghost-wallet refuses without allowMainnet (real-funds networks). */
export const MAINNET_CHAIN_IDS = new Set([
  1, 10, 25, 56, 100, 137, 250, 324, 1101, 5000, 8453, 42161, 42220, 43114,
  59144, 81457, 534352, 7777777,
]);

export interface LogEntry {
  id: number;
  ts: number;
  method: string;
  params: unknown;
  status: "approved" | "rejected" | "error" | "pending" | "passthrough";
  result?: unknown;
  error?: string;
  /** Human-readable decode of what was asked to be signed (see decode.ts). */
  decoded?: DecodedRequest;
}

export interface SiweFields {
  domain?: string;
  address?: string;
  statement?: string;
  uri?: string;
  chainId?: number;
  nonce?: string;
  issuedAt?: string;
}

export interface DecodedRequest {
  kind: "message" | "siwe" | "typed-data" | "transaction";
  /** UTF-8 text for messages, primaryType summary for typed data. */
  summary: string;
  siwe?: SiweFields;
  primaryType?: string;
  domainName?: string;
}

export type SgwEvent = {
  type: "request" | "settled" | "config";
  id: number;
  method: string;
  status?: LogEntry["status"];
  /** The full log entry — present on `settled`, so listeners need no lookup. */
  entry?: LogEntry;
};

export interface PendingRequest {
  id: number;
  method: string;
  params: unknown;
}

export class ProviderRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const USER_REJECTED = () =>
  new ProviderRpcError(4001, "Super Ghost Wallet: user rejected the request");
