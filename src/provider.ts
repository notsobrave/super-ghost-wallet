import {
  createWalletClient,
  defineChain,
  http,
  isAddress,
  isHex,
  numberToHex,
  hexToString,
  type Hex,
} from "viem";
import {
  mnemonicToAccount,
  privateKeyToAccount,
  type HDAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import {
  DEFAULT_CONFIG,
  MAINNET_CHAIN_IDS,
  ProviderRpcError,
  USER_REJECTED,
  type GhostConfig,
  type LogEntry,
  type Mode,
  type PendingRequest,
  type SgwEvent,
} from "./types.js";
import { decodeRequest } from "./decode.js";

type Account = HDAccount | PrivateKeyAccount;
type Listener = (...args: unknown[]) => void;

/** Methods that a real wallet would gate behind a user prompt. */
const SENSITIVE = new Set([
  "eth_requestAccounts",
  "personal_sign",
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
]);

const LOG_CAP = 500;

interface Pending extends PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface QueuedFailure {
  method: string;
  code: number;
  message: string;
}

interface Waiter {
  method: string;
  resolve: (entry: LogEntry) => void;
}

export class GhostProvider {
  // EIP-1193 identity flags some dApps sniff for.
  readonly isSuperGhostWallet = true;

  config: GhostConfig;
  private accounts: Account[] = [];
  private connected = false;
  private listeners = new Map<string, Set<Listener>>();
  private log: LogEntry[] = [];
  private pendingQueue = new Map<number, Pending>();
  private nextId = 1;
  private persist: (config: GhostConfig) => void;
  private onEvent: (e: SgwEvent) => void;
  private failQueue: QueuedFailure[] = [];
  private waiters: Waiter[] = [];

  constructor(
    config: Partial<GhostConfig> = {},
    persist: (config: GhostConfig) => void = () => {},
    onEvent: (e: SgwEvent) => void = () => {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.persist = persist;
    this.onEvent = onEvent;
    this.assertChainAllowed(this.config.chainId);
    this.deriveAccounts();
  }

  // ── accounts ──────────────────────────────────────────────────────

  private deriveAccounts() {
    const out: Account[] = [];
    for (let i = 0; i < this.config.accountCount; i++) {
      out.push(mnemonicToAccount(this.config.mnemonic, { addressIndex: i }));
    }
    for (const pk of this.config.privateKeys) out.push(privateKeyToAccount(pk));
    this.accounts = out;
    if (this.config.accountIndex >= out.length) this.config.accountIndex = 0;
  }

  get activeAccount(): Account {
    return this.accounts[this.config.accountIndex];
  }

  get addresses(): string[] {
    return this.accounts.map((a) => a.address);
  }

  private accountFor(address: unknown): Account {
    if (typeof address === "string" && isAddress(address, { strict: false })) {
      const hit = this.accounts.find(
        (a) => a.address.toLowerCase() === address.toLowerCase(),
      );
      if (hit) return hit;
    }
    return this.activeAccount;
  }

  // ── config mutation (control API) ─────────────────────────────────

  applyConfig(config: Partial<GhostConfig>, save = true) {
    const prevChain = this.config.chainId;
    const prevAddr = this.activeAccount?.address;
    this.config = { ...this.config, ...config };
    this.assertChainAllowed(this.config.chainId);
    this.deriveAccounts();
    if (save) this.persist(this.config);
    if (this.config.chainId !== prevChain)
      this.emit("chainChanged", numberToHex(this.config.chainId));
    if (this.connected && this.activeAccount.address !== prevAddr)
      this.emit("accountsChanged", [this.activeAccount.address]);
  }

  useAccount(index: number) {
    if (index < 0 || index >= this.accounts.length)
      throw new Error(`super-ghost-wallet: no account at index ${index}`);
    this.applyConfig({ accountIndex: index });
  }

  importKey(pk: `0x${string}`) {
    this.applyConfig({ privateKeys: [...this.config.privateKeys, pk] });
    return this.accounts[this.accounts.length - 1].address;
  }

  setChain(chainId: number, rpcUrl?: string) {
    this.assertChainAllowed(chainId);
    const rpcUrls = { ...this.config.rpcUrls };
    if (rpcUrl) rpcUrls[String(chainId)] = rpcUrl;
    if (!rpcUrls[String(chainId)])
      throw new ProviderRpcError(
        4902,
        `Super Ghost Wallet: no RPC url configured for chain ${chainId}`,
      );
    this.applyConfig({ chainId, rpcUrls });
  }

  private assertChainAllowed(chainId: number) {
    if (MAINNET_CHAIN_IDS.has(chainId) && !this.config.allowMainnet)
      throw new ProviderRpcError(
        4100,
        `Super Ghost Wallet: chain ${chainId} looks like a real-funds network. ` +
          `Set allowMainnet: true to override (test keys only!).`,
      );
  }

  // ── log / queue ───────────────────────────────────────────────────

  getLog(): LogEntry[] {
    return [...this.log];
  }

  clearLog() {
    this.log = [];
  }

  private pushLog(entry: LogEntry) {
    this.log.push(entry);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
  }

  pending(): PendingRequest[] {
    return [...this.pendingQueue.values()].map(({ id, method, params }) => ({
      id,
      method,
      params,
    }));
  }

  approve(id: number) {
    const p = this.pendingQueue.get(id);
    if (!p) throw new Error(`super-ghost-wallet: no pending request ${id}`);
    this.pendingQueue.delete(id);
    p.resolve(undefined);
  }

  deny(id: number) {
    const p = this.pendingQueue.get(id);
    if (!p) throw new Error(`super-ghost-wallet: no pending request ${id}`);
    this.pendingQueue.delete(id);
    p.reject(USER_REJECTED());
  }

  /** Effective mode for a method: per-method policy wins over the global mode. */
  modeFor(method: string): Mode {
    return this.config.policies[method] ?? this.config.mode;
  }

  /** Resolves when the request is approved; rejects on deny/reject mode. */
  private gate(id: number, method: string, params: unknown): Promise<void> {
    if (!SENSITIVE.has(method)) return Promise.resolve();
    const mode = this.modeFor(method);
    if (mode === "auto") return Promise.resolve();
    if (mode === "reject") return Promise.reject(USER_REJECTED());
    return new Promise((resolve, reject) => {
      this.pendingQueue.set(id, {
        id,
        method,
        params,
        resolve: () => resolve(),
        reject,
      });
    });
  }

  /** Queue a one-shot failure for the next matching request ("*" = any sensitive). */
  failNext(method: string, code = 4001, message?: string) {
    this.failQueue.push({
      method,
      code,
      message: message ?? `Super Ghost Wallet: injected error ${code}`,
    });
  }

  /** Resolves with the log entry of the next settled request for `method`. */
  waitForRequest(method: string): Promise<LogEntry> {
    return new Promise((resolve) => this.waiters.push({ method, resolve }));
  }

  private settle(entry: LogEntry) {
    this.onEvent({ type: "settled", id: entry.id, method: entry.method, status: entry.status });
    const matched = this.waiters.filter(
      (w) => w.method === entry.method || w.method === "*",
    );
    this.waiters = this.waiters.filter((w) => !matched.includes(w));
    for (const w of matched) w.resolve(entry);
  }

  // ── dApp-behavior simulations (test reconnection paths) ──────────

  simulateDisconnect() {
    this.connected = false;
    this.emit("accountsChanged", []);
    this.emit("disconnect", new ProviderRpcError(4900, "Super Ghost Wallet: simulated disconnect"));
  }

  simulateAccountsChanged(index?: number) {
    if (index !== undefined) this.useAccount(index);
    else this.emit("accountsChanged", this.connected ? [this.activeAccount.address] : []);
  }

  simulateChainChanged(chainId?: number) {
    if (chainId !== undefined) this.setChain(chainId);
    else this.emit("chainChanged", numberToHex(this.config.chainId));
  }

  // ── events (EIP-1193) ─────────────────────────────────────────────

  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  removeListener(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  private emit(event: string, payload: unknown) {
    for (const l of this.listeners.get(event) ?? []) {
      try {
        l(payload);
      } catch {
        /* listener errors are the dApp's problem */
      }
    }
  }

  // ── EIP-1193 request ──────────────────────────────────────────────

  async request(args: { method: string; params?: unknown }): Promise<unknown> {
    const { method } = args;
    const params = (args.params ?? []) as unknown[];
    const id = this.nextId++;
    const sensitive = SENSITIVE.has(method);
    const entry: LogEntry = {
      id,
      ts: Date.now(),
      method,
      params,
      status: "pending",
      decoded: sensitive ? decodeRequest(method, params) : undefined,
    };
    if (sensitive) {
      this.pushLog(entry);
      this.onEvent({ type: "request", id, method });
    }
    try {
      const injected = this.failQueue.findIndex(
        (f) => f.method === method || (f.method === "*" && sensitive),
      );
      if (injected !== -1) {
        const [f] = this.failQueue.splice(injected, 1);
        throw new ProviderRpcError(f.code, f.message);
      }
      await this.gate(id, method, params);
      if (sensitive && this.config.delayMs > 0)
        await new Promise((r) => setTimeout(r, this.config.delayMs));
      const result = await this.handle(method, params);
      entry.status = sensitive ? "approved" : "passthrough";
      entry.result = result;
      return result;
    } catch (err) {
      entry.status =
        err instanceof ProviderRpcError && err.code === 4001
          ? "rejected"
          : "error";
      entry.error = err instanceof Error ? err.message : String(err);
      if (!sensitive && entry.status === "error") this.pushLog(entry);
      throw err;
    } finally {
      if (entry.status !== "pending" && (sensitive || entry.status === "error"))
        this.settle(entry);
    }
  }

  private async handle(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "eth_requestAccounts": {
        this.connected = true;
        this.emit("connect", { chainId: numberToHex(this.config.chainId) });
        this.emit("accountsChanged", [this.activeAccount.address]);
        return [this.activeAccount.address];
      }
      case "eth_accounts":
        return this.connected || this.config.autoConnect
          ? [this.activeAccount.address]
          : [];
      case "eth_chainId":
        return numberToHex(this.config.chainId);
      case "net_version":
        return String(this.config.chainId);
      case "eth_coinbase":
        return this.activeAccount.address;

      case "personal_sign": {
        // MetaMask convention: [data, address]; tolerate swapped order.
        let [data, address] = params as [unknown, unknown];
        if (
          typeof data === "string" &&
          isAddress(data, { strict: false }) &&
          typeof address === "string" &&
          !isAddress(address, { strict: false })
        )
          [data, address] = [address, data];
        const account = this.accountFor(address);
        const message =
          typeof data === "string" && isHex(data)
            ? { raw: data as Hex }
            : String(data);
        return account.signMessage({ message });
      }

      case "eth_sign":
        throw new ProviderRpcError(
          4200,
          "Super Ghost Wallet: eth_sign is disabled (legacy footgun); use personal_sign",
        );

      case "eth_signTypedData":
      case "eth_signTypedData_v3":
      case "eth_signTypedData_v4": {
        // [address, typedDataJSON] (v1 legacy [data, address] not supported)
        const [address, json] = params as [unknown, unknown];
        const typed = typeof json === "string" ? JSON.parse(json) : json;
        return this.accountFor(address).signTypedData(typed);
      }

      case "eth_sendTransaction": {
        const [tx] = params as [Record<string, unknown>];
        return this.sendTransaction(tx);
      }

      case "wallet_switchEthereumChain": {
        const [{ chainId }] = params as [{ chainId: string }];
        this.setChain(Number(chainId));
        return null;
      }
      case "wallet_addEthereumChain": {
        const [spec] = params as [
          { chainId: string; rpcUrls?: string[] },
        ];
        const cid = Number(spec.chainId);
        this.setChain(cid, spec.rpcUrls?.[0]);
        return null;
      }

      case "wallet_requestPermissions":
      case "wallet_getPermissions":
        return [{ parentCapability: "eth_accounts" }];
      case "wallet_revokePermissions": {
        this.connected = false;
        this.emit("accountsChanged", []);
        return null;
      }

      default:
        return this.passthrough(method, params);
    }
  }

  // ── transaction + RPC plumbing ────────────────────────────────────

  private rpcUrl(): string {
    const url = this.config.rpcUrls[String(this.config.chainId)];
    if (!url)
      throw new ProviderRpcError(
        4901,
        `Super Ghost Wallet: no RPC url for chain ${this.config.chainId}`,
      );
    return url;
  }

  private chain() {
    return defineChain({
      id: this.config.chainId,
      name: `super-ghost-wallet-${this.config.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl()] } },
    });
  }

  private async sendTransaction(tx: Record<string, unknown>) {
    const account = this.accountFor(tx.from);
    const client = createWalletClient({
      account,
      chain: this.chain(),
      transport: http(this.rpcUrl()),
    });
    const big = (v: unknown) => (v == null ? undefined : BigInt(v as string));
    const num = (v: unknown) => (v == null ? undefined : Number(v));
    return client.sendTransaction({
      to: (tx.to as Hex) ?? undefined,
      data: (tx.data ?? tx.input) as Hex | undefined,
      value: big(tx.value),
      gas: big(tx.gas),
      nonce: num(tx.nonce),
      gasPrice: big(tx.gasPrice),
      maxFeePerGas: big(tx.maxFeePerGas),
      maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas),
    } as never);
  }

  private async passthrough(method: string, params: unknown[]) {
    const res = await fetch(this.rpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    const body = (await res.json()) as {
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    if (body.error)
      throw new ProviderRpcError(
        body.error.code,
        body.error.message,
        body.error.data,
      );
    return body.result;
  }

  /** Human-readable decode helper used by the control API's log view. */
  static decodePersonalSignParams(params: unknown): string | undefined {
    if (!Array.isArray(params)) return undefined;
    const data = params.find((p) => typeof p === "string" && isHex(p) && !isAddress(p as string, { strict: false }));
    if (typeof data !== "string") return undefined;
    try {
      return hexToString(data as Hex);
    } catch {
      return undefined;
    }
  }
}
