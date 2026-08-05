import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { mnemonicToSeedSync } from "@scure/bip39";

/**
 * Solana side of the wallet: SLIP-0010 ed25519 derivation (Phantom-compatible
 * path m/44'/501'/i'/0'), raw transaction signing, SIWS message building, and
 * the Wallet Standard adapter that exposes it all to Solana dApps.
 */

/* ── SLIP-0010 (ed25519, hardened-only) ─────────────────────────────── */

interface Slip10Node {
  key: Uint8Array;
  chainCode: Uint8Array;
}

const HARDENED = 0x80000000;

function slip10Master(seed: Uint8Array): Slip10Node {
  const I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function slip10Child(parent: Slip10Node, index: number): Slip10Node {
  const data = new Uint8Array(37);
  data[0] = 0;
  data.set(parent.key, 1);
  new DataView(data.buffer).setUint32(33, (index | HARDENED) >>> 0, false);
  const I = hmac(sha512, parent.chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

/** Exposed so tests can pin the derivation to the SLIP-0010 vectors. */
export const slip10Internals = () => ({ master: slip10Master, child: slip10Child });

export interface SolanaAccount {
  index: number;
  secretKey: Uint8Array; // 32-byte seed
  publicKey: Uint8Array;
  address: string; // base58 pubkey
}

/** Derive m/44'/501'/i'/0' — the path Phantom/Solflare use for mnemonics. */
export function deriveSolanaAccounts(mnemonic: string, count: number): SolanaAccount[] {
  const seed = mnemonicToSeedSync(mnemonic);
  const master = slip10Master(seed);
  const purpose = slip10Child(slip10Child(master, 44), 501);
  const out: SolanaAccount[] = [];
  for (let i = 0; i < count; i++) {
    const node = slip10Child(slip10Child(purpose, i), 0);
    const publicKey = ed25519.getPublicKey(node.key);
    out.push({ index: i, secretKey: node.key, publicKey, address: base58.encode(publicKey) });
  }
  return out;
}

export const solSign = (message: Uint8Array, account: SolanaAccount) =>
  ed25519.sign(message, account.secretKey);

/* ── transaction signing (legacy + v0, no @solana/web3.js) ──────────── */

function readShortVec(bytes: Uint8Array, offset: number): [number, number] {
  let len = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[offset++];
    len |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [len, offset];
    shift += 7;
  }
}

/**
 * Sign a serialized Solana transaction: locate our pubkey among the static
 * account keys, sign the message bytes, splice the signature into its slot.
 */
export function signSolanaTransaction(
  serialized: Uint8Array,
  account: SolanaAccount,
): { signedTransaction: Uint8Array; signature: Uint8Array } {
  const [numSigs, sigsStart] = readShortVec(serialized, 0);
  const messageStart = sigsStart + numSigs * 64;
  const message = serialized.slice(messageStart);

  let o = 0;
  if (message[o] & 0x80) o += 1; // versioned message prefix
  o += 3; // header: numRequired, numReadonlySigned, numReadonlyUnsigned
  const [numKeys, keysStart] = readShortVec(message, o);
  let keyIndex = -1;
  for (let i = 0; i < numKeys; i++) {
    const key = message.slice(keysStart + i * 32, keysStart + (i + 1) * 32);
    if (key.length === 32 && key.every((b, j) => b === account.publicKey[j])) {
      keyIndex = i;
      break;
    }
  }
  if (keyIndex === -1 || keyIndex >= numSigs)
    throw new Error(
      `super-ghost-wallet: account ${account.address} is not a required signer of this transaction`,
    );

  const signature = solSign(message, account);
  const signedTransaction = new Uint8Array(serialized);
  signedTransaction.set(signature, sigsStart + keyIndex * 64);
  return { signedTransaction, signature };
}

/* ── SIWS (Sign In With Solana) ─────────────────────────────────────── */

export interface SiwsInput {
  domain?: string;
  address?: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  requestId?: string;
  resources?: string[];
}

export function buildSiwsMessage(input: SiwsInput, fallbackDomain: string, address: string): string {
  const domain = input.domain ?? fallbackDomain;
  const lines = [`${domain} wants you to sign in with your Solana account:`, address];
  if (input.statement) lines.push("", input.statement);
  const fields: string[] = [];
  if (input.uri) fields.push(`URI: ${input.uri}`);
  if (input.version) fields.push(`Version: ${input.version}`);
  if (input.chainId) fields.push(`Chain ID: ${input.chainId}`);
  if (input.nonce) fields.push(`Nonce: ${input.nonce}`);
  if (input.issuedAt) fields.push(`Issued At: ${input.issuedAt}`);
  if (input.expirationTime) fields.push(`Expiration Time: ${input.expirationTime}`);
  if (input.requestId) fields.push(`Request ID: ${input.requestId}`);
  if (input.resources?.length)
    fields.push("Resources:", ...input.resources.map((r) => `- ${r}`));
  if (fields.length) lines.push("", ...fields);
  return lines.join("\n");
}

/* ── Wallet Standard adapter ────────────────────────────────────────── */

/** Minimal request surface the adapter needs from the provider. */
export interface SolanaHost {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  solanaAccount(): SolanaAccount;
  solanaChain(): string; // e.g. "solana:devnet"
  walletName(): string;
  walletIcon(): string;
}

function standardAccount(host: SolanaHost) {
  const acc = host.solanaAccount();
  return {
    address: acc.address,
    publicKey: acc.publicKey,
    chains: [host.solanaChain()],
    features: [
      "solana:signMessage",
      "solana:signTransaction",
      "solana:signAndSendTransaction",
      "solana:signIn",
    ],
  };
}

/** Build the Wallet Standard wallet object and register it on window. */
export function registerSolanaWallet(host: SolanaHost) {
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const wallet = {
    version: "1.0.0" as const,
    get name() {
      return host.walletName();
    },
    get icon() {
      return host.walletIcon();
    },
    get chains() {
      return [host.solanaChain()];
    },
    get accounts() {
      return [standardAccount(host)];
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          await host.request({ method: "solana_connect" });
          return { accounts: [standardAccount(host)] };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => {
          await host.request({ method: "solana_disconnect" });
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (event: string, cb: (...a: unknown[]) => void) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(cb);
          return () => listeners.get(event)?.delete(cb);
        },
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (...inputs: { account: unknown; message: Uint8Array }[]) =>
          Promise.all(
            inputs.map(async ({ message }) => {
              const r = (await host.request({
                method: "solana_signMessage",
                params: [message],
              })) as { signature: Uint8Array };
              return { signedMessage: message, signature: r.signature };
            }),
          ),
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          Promise.all(
            inputs.map(async ({ transaction }) => {
              const r = (await host.request({
                method: "solana_signTransaction",
                params: [transaction],
              })) as { signedTransaction: Uint8Array };
              return { signedTransaction: r.signedTransaction };
            }),
          ),
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          Promise.all(
            inputs.map(async ({ transaction }) => ({
              signature: (await host.request({
                method: "solana_signAndSendTransaction",
                params: [transaction],
              })) as Uint8Array,
            })),
          ),
      },
      "solana:signIn": {
        version: "1.0.0",
        signIn: async (...inputs: SiwsInput[]) =>
          Promise.all(
            (inputs.length ? inputs : [{}]).map(async (input) => {
              const r = (await host.request({
                method: "solana_signIn",
                params: [input],
              })) as { signedMessage: Uint8Array; signature: Uint8Array };
              return { account: standardAccount(host), ...r };
            }),
          ),
      },
    },
    /** Notify Wallet Standard consumers (account switch etc.). */
    emitChange() {
      for (const cb of listeners.get("change") ?? [])
        cb({ accounts: [standardAccount(host)] });
    },
  };

  const callback = ({ register }: { register: (w: unknown) => void }) => register(wallet);
  try {
    window.dispatchEvent(
      new CustomEvent("wallet-standard:register-wallet", { detail: callback }),
    );
  } catch {
    /* no window (tests) */
  }
  try {
    window.addEventListener("wallet-standard:app-ready", ((e: CustomEvent) =>
      callback(e.detail)) as EventListener);
  } catch {
    /* no window */
  }
  return wallet;
}
