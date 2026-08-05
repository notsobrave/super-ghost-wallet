import { GhostProvider } from "./provider.js";
import { buildControlApi, installClipboardHook } from "./control.js";
import { isBridgeMessage, post } from "./bridge.js";
import { registerSolanaWallet } from "./solana.js";
import type { GhostConfig } from "./types.js";

// ── persisted-config handshake with the ISOLATED content script ─────
let provider: GhostProvider;

function persist(config: GhostConfig) {
  post("persist", config);
}

window.addEventListener("message", (e) => {
  if (e.source !== window || !isBridgeMessage(e.data)) return;
  if (e.data.type === "config" && e.data.config && provider) {
    // Stored config wins over defaults, but never mid-flight surprises:
    // applied without re-persisting to avoid a write loop.
    provider.applyConfig(e.data.config as Partial<GhostConfig>, false);
  }
});

provider = new GhostProvider({}, persist, (e) => {
  // Observation hook: pages/tests can listen without polling getLog().
  window.dispatchEvent(new CustomEvent("sgw:request", { detail: e }));
  // Identity may have changed (impersonate) — re-announce EIP-6963.
  if (e.type === "config") announce();
});
post("get-config");

// ── expose EIP-1193 surface ─────────────────────────────────────────
const anyWindow = window as never as Record<string, unknown>;
if (!anyWindow.ethereum) anyWindow.ethereum = provider;
anyWindow.__sgw = buildControlApi(provider);
installClipboardHook();

// ── EIP-6963 announce ───────────────────────────────────────────────
const GHOST_ICON =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#8b8bf4" d="M16 3c-6 0-10 4.6-10 10.5V27l3.4-2.6L13 27l3-2.4L19 27l3.6-2.6L26 27V13.5C26 7.6 22 3 16 3z"/><circle cx="12" cy="13" r="2" fill="#fff"/><circle cx="20" cy="13" r="2" fill="#fff"/></svg>`,
  );

const uuid = crypto.randomUUID();

function announce() {
  const identity = provider.identity();
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({
        info: Object.freeze({ uuid, name: identity.name, icon: GHOST_ICON, rdns: identity.rdns }),
        provider,
      }),
    }),
  );
}

window.addEventListener("eip6963:requestProvider", announce);
announce();

// ── Solana (Wallet Standard) ────────────────────────────────────────
registerSolanaWallet({
  request: (args) => provider.request(args),
  solanaAccount: () => provider.activeSolanaAccount,
  solanaChain: () => `solana:${provider.config.solanaCluster}`,
  walletName: () => provider.identity().name,
  walletIcon: () => GHOST_ICON,
});
