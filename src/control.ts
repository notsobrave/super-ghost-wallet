import type { GhostProvider } from "./provider.js";
import type { Hud } from "./hud.js";
import { HUD_ATTR } from "./hud.js";
import type { GhostConfig, Mode } from "./types.js";

/**
 * The in-page control plane an agent drives via evaluate_script.
 * Everything returns plain JSON-serializable data.
 */
export function buildControlApi(provider: GhostProvider, hud?: Hud) {
  return {
    /** Narrate a step of your own in the HUD ("about to connect…"). No-op when off. */
    say: (text: string, detail?: string) => {
      hud?.note(text, detail);
      return "ok";
    },
    clearHud: () => {
      hud?.clear();
      return "ok";
    },
    getState() {
      const { mnemonic: _hidden, privateKeys: _hidden2, ...safe } =
        provider.config;
      return {
        ...safe,
        accounts: provider.addresses,
        activeAccount: provider.activeAccount.address,
        solanaAccounts: provider.solanaAddresses,
        activeSolanaAccount: provider.activeSolanaAccount.address,
        identity: provider.identity(),
        pending: provider.pending(),
      };
    },
    /** Fresh random TEST wallet (EVM + Solana from one mnemonic). Returns the
     *  mnemonic ONCE — write it down if the test needs to re-import it. */
    generateWallet: (count?: number) => provider.generateWallet(count),
    /** Behavioral profile: "ledger" (slow device confirm + blind-signing off),
     *  "mobile" (slow remote signer), null (instant). */
    setProfile: (profile: "ledger" | "mobile" | null) => {
      provider.applyConfig({
        profile,
        ...(profile === "ledger" ? { blindSigning: false } : {}),
      });
      return provider.config.profile;
    },
    enableBlindSigning: () => {
      provider.applyConfig({ blindSigning: true });
      return "ok";
    },
    /** Present as another wallet in discovery ("metamask" | "phantom" | null). */
    impersonate: (as: "metamask" | "phantom" | null) => {
      provider.applyConfig({ impersonate: as });
      return provider.identity();
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
    /**
     * The `wc:` URI a dApp's connect-modal QR code encodes — what a phone
     * would read by scanning it. Feed it to the Node-side RemoteWallet
     * (`sgw pair <uri>`) to complete the pairing without a camera.
     * Scans light DOM + shadow roots (AppKit/RainbowKit render there) and
     * anything the page copied to the clipboard.
     */
    findWalletConnectUri: () => findWcUri(),
    clearWalletConnectUri: () => clearWcUri(),
    /**
     * Show what the wallet is doing, in the page: `hud(true)` for toasts +
     * log panel, or pick parts — `hud({ toasts: true, panel: false })`.
     * Off by default so it never disturbs an existing suite. Toasts are
     * pointer-events:none, so they can't intercept a click.
     */
    hud: (on: boolean | Partial<{ toasts: boolean; panel: boolean; position: GhostConfig["hudPosition"] }> = true) => {
      const patch =
        typeof on === "boolean"
          ? { hudToasts: on, hudPanel: on }
          : {
              ...(on.toasts !== undefined ? { hudToasts: on.toasts } : {}),
              ...(on.panel !== undefined ? { hudPanel: on.panel } : {}),
              ...(on.position ? { hudPosition: on.position } : {}),
            };
      provider.applyConfig(patch);
      return {
        toasts: provider.config.hudToasts,
        panel: provider.config.hudPanel,
        position: provider.config.hudPosition,
      };
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

/** Last value the page passed to navigator.clipboard.writeText (hooked below). */
let lastCopied = "";

const WC_URI = /wc:[0-9a-f]{64}@\d+\?[^\s"'<>]+/i;

/**
 * Hook clipboard writes: "Copy connection link" in a WalletConnect modal is
 * often the only place the full URI is exposed as text.
 */
export function installClipboardHook() {
  try {
    const clip = navigator.clipboard;
    if (!clip?.writeText) return;
    const original = clip.writeText.bind(clip);
    clip.writeText = (text: string) => {
      if (WC_URI.test(text)) lastCopied = text;
      return original(text);
    };
  } catch {
    /* clipboard unavailable — DOM scan still works */
  }
}

function* walk(root: Document | ShadowRoot | Element): Generator<Element> {
  const els = root.querySelectorAll("*");
  for (const el of els) {
    // Never scan our own HUD: it renders URIs it was told about, and finding
    // one there would just echo a stale pairing back at the caller.
    if (el.hasAttribute(HUD_ATTR)) continue;
    yield el;
    if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot)
      yield* walk((el as Element & { shadowRoot: ShadowRoot }).shadowRoot);
  }
}

/** Forget a captured clipboard URI (a closed modal's URI is dead). */
export function clearWcUri() {
  lastCopied = "";
}

/**
 * Find a `wc:` pairing URI anywhere the page exposes one. The live DOM wins
 * over a clipboard capture: the clipboard keeps the last URI forever, so a
 * closed-and-reopened modal would otherwise hand back a dead pairing.
 */
export function findWcUri(): string | null {
  for (const el of walk(document)) {
    for (const attr of el.attributes) {
      const hit = WC_URI.exec(attr.value);
      if (hit) return hit[0];
    }
    // some modals render the URI as text next to the QR
    const text = (el as HTMLElement).innerText;
    if (typeof text === "string" && text.includes("wc:")) {
      const hit = WC_URI.exec(text);
      if (hit) return hit[0];
    }
  }
  const copied = WC_URI.exec(lastCopied);
  return copied ? copied[0] : null;
}
