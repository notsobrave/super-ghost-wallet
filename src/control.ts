import type { GhostProvider } from "./provider.js";
import type { GhostConfig, Mode } from "./types.js";

/**
 * The in-page control plane an agent drives via evaluate_script.
 * Everything returns plain JSON-serializable data.
 */
export function buildControlApi(provider: GhostProvider) {
  return {
    getState() {
      const { mnemonic: _hidden, privateKeys: _hidden2, ...safe } =
        provider.config;
      return {
        ...safe,
        accounts: provider.addresses,
        activeAccount: provider.activeAccount.address,
        pending: provider.pending(),
      };
    },
    getLog: () => provider.getLog(),
    clearLog: () => provider.clearLog(),
    useAccount: (i: number) => {
      provider.useAccount(i);
      return provider.activeAccount.address;
    },
    importKey: (pk: `0x${string}`) => provider.importKey(pk),
    setChain: (chainId: number, rpcUrl?: string) => {
      provider.setChain(chainId, rpcUrl);
      return provider.config.chainId;
    },
    setMode: (mode: Mode) => {
      if (!["auto", "reject", "queue"].includes(mode))
        throw new Error(`super-ghost-wallet: unknown mode "${mode}"`);
      provider.applyConfig({ mode });
      return mode;
    },
    configure: (patch: Partial<GhostConfig>) => {
      provider.applyConfig(patch);
      return "ok";
    },
    pending: () => provider.pending(),
    approve: (id: number) => provider.approve(id),
    deny: (id: number) => provider.deny(id),
    /** Per-method mode overrides, e.g. setPolicy({ eth_sendTransaction: "reject" }). */
    setPolicy: (policies: Record<string, Mode>) => {
      provider.applyConfig({ policies: { ...provider.config.policies, ...policies } });
      return provider.config.policies;
    },
    clearPolicies: () => {
      provider.applyConfig({ policies: {} });
      return "ok";
    },
    /** Inject a one-shot EIP-1193 error on the next matching request ("*" = any). */
    failNext: (method: string, code?: number, message?: string) => {
      provider.failNext(method, code, message);
      return "ok";
    },
    /** Artificial latency on sensitive requests — spinner/loading-state testing. */
    setDelay: (ms: number) => {
      provider.applyConfig({ delayMs: Math.max(0, ms) });
      return provider.config.delayMs;
    },
    /** Resolves with the log entry of the next settled request for method ("*" = any). */
    waitForRequest: (method: string) => provider.waitForRequest(method),
    simulateDisconnect: () => provider.simulateDisconnect(),
    simulateAccountsChanged: (index?: number) => provider.simulateAccountsChanged(index),
    simulateChainChanged: (chainId?: number) => provider.simulateChainChanged(chainId),
  };
}

export type ControlApi = ReturnType<typeof buildControlApi>;
