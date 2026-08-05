# 👻 Super Ghost Wallet

Headless auto-signing **test wallet** packaged as a Chrome MV3 extension, built so
AI agents (Claude Code via playwright MCP / chrome-devtools MCP) — or plain Playwright
scripts — can test dApp flows that normally require a human clicking "Approve" in a
wallet popup: connect, SIWE / signature auth, typed-data signing, transactions.

It announces itself via **EIP-6963** (plus legacy `window.ethereum`), so wagmi,
RainbowKit, Reown AppKit, ConnectKit and friends detect it like a real injected wallet.
**Zero changes needed in the dApp under test.**

> ⚠️ **Test keys only.** Ships with the public anvil/hardhat mnemonic and refuses
> well-known mainnet chain ids unless you explicitly set `allowMainnet: true`.
> Never import a key that holds real funds.

## Install & build

```sh
git clone https://github.com/notsobrave/super-ghost-wallet.git
cd super-ghost-wallet
npm install
npm run build        # -> dist/ (the loadable extension)
```

## Use as a Claude Code plugin

The repo doubles as a Claude Code plugin marketplace. Once installed, the
`super-ghost-wallet` skill teaches the agent to build, load and drive the wallet
on its own:

```
/plugin marketplace add notsobrave/super-ghost-wallet
/plugin install super-ghost-wallet@super-ghost-wallet
```

## Load into an agent-driven browser

Any Chromium launched with these flags has the wallet in every page:

```
--disable-extensions-except=/abs/path/super-ghost-wallet/dist
--load-extension=/abs/path/super-ghost-wallet/dist
```

- **playwright MCP**: add the flags via `--browser-arg`, or in the MCP config
  (`browser.launchOptions.args`). Headless works (new headless supports MV3).
- **chrome-devtools MCP**: pass the same flags through `--browser-arg` /
  `chromeArgs`, or attach to a Chrome you started yourself with the flags.
- **Plain Playwright**: `chromium.launchPersistentContext("", { channel: "chromium",
  headless: true, args: [...] })` — see `e2e/wallet.spec.ts`.

## Defaults

| | |
|---|---|
| Accounts | 10 accounts from the anvil mnemonic (`0xf39F…2266` first) |
| Chain | 31337, RPC `http://127.0.0.1:8545` |
| Mode | `auto` (sign everything instantly) |
| Mainnet | refused unless `allowMainnet: true` |

Config persists in `chrome.storage.local` across pages and reloads.

## Control API — `window.__sgw`

The agent drives the wallet from page context (`evaluate_script` / `browser_evaluate`):

```js
__sgw.getState()                 // accounts, activeAccount, chainId, mode… (no secrets)
__sgw.getLog()                   // every sensitive request: method, params, status, result
__sgw.clearLog()
__sgw.useAccount(2)              // switch active account
__sgw.importKey("0x…")           // add a raw private key (test keys only!)
__sgw.setChain(84532, "https://sepolia.base.org")   // switch / add chain
__sgw.setMode("auto" | "reject" | "queue")
__sgw.pending()                  // queue mode: parked requests
__sgw.approve(id) / .deny(id)    // queue mode: resolve them
__sgw.configure({ autoConnect: true, accountCount: 3, … })

// test ergonomics
__sgw.setPolicy({ eth_sendTransaction: "reject" })   // per-method mode overrides
__sgw.clearPolicies()
__sgw.failNext("personal_sign", 4902, "msg")   // one-shot error injection ("*" = any)
__sgw.setDelay(1500)                           // latency on sensitive requests — spinner testing
await __sgw.waitForRequest("personal_sign")    // resolves with the settled log entry ("*" = any)
__sgw.simulateDisconnect()                     // 4900 + accountsChanged([]) — reconnection paths
__sgw.simulateAccountsChanged(2) / .simulateChainChanged()
```

```js
// identity & keys
__sgw.generateWallet(5)      // fresh RANDOM test wallet — returns the mnemonic ONCE
__sgw.impersonate("metamask" | "phantom" | null)   // for dApps with hardcoded lists
__sgw.setProfile("ledger")   // hardware wallet: ~3s device confirm + blind signing OFF
__sgw.enableBlindSigning()   // the device setting a real Ledger makes you toggle
__sgw.findWalletConnectUri() // the wc: URI behind the QR code (see below)
```

Log entries carry a `decoded` field: UTF-8 text for `personal_sign`, **parsed SIWE
fields** (domain / address / nonce / statement) when the message is EIP-4361,
`EIP-712 <primaryType> @ <domain>` for typed data, and a value/target summary for
transactions — assert on *meaning*, not hex.

Events: every sensitive request dispatches `sgw:request` CustomEvents on `window`
(`{ type: "request" | "settled", id, method, status }`) — observe without polling.

- **`reject` mode** returns EIP-1193 error **4001** on sensitive methods — test your
  "user rejected signature" paths, which is near-impossible with a real wallet.
- **`getLog()`** lets the agent *assert what the dApp asked to sign*, not just that
  the UI moved on.

## RPC behavior

- `personal_sign`, `eth_signTypedData(_v3/_v4)` — signed locally, instantly.
- `eth_sendTransaction` — signed locally, gas/nonce filled, raw tx sent to the
  configured RPC (anvil, hardhat, testnet…).
- `eth_sign` — disabled (legacy footgun).
- Everything else (`eth_call`, `eth_estimateGas`, …) — passthrough to the RPC.

## Watching the agent work — the in-page HUD

When a human is watching an agent drive the browser, the wallet can narrate
itself: capsule toasts announcing each action, and a side panel holding the
full log.

```js
__sgw.hud(true)                                  // toasts + panel
__sgw.hud({ toasts: true, panel: false })        // pick parts
__sgw.hud({ position: "bottom-left" })           // any corner
__sgw.say("Connecting wallet", "clicked Connect")// narrate your own step
__sgw.clearHud()
__sgw.hud(false)
```

Toasts are pill-shaped and stretch a body out of themselves via an SVG gooey
filter (inspired by [Sileo](https://sileo.aaryan.design)), showing what was
signed — decoded, not hex. The panel lists every request with a timestamp and
a status dot.

Design constraints that matter for testing:

- **Off by default** — an overlay must never silently change an existing suite.
- **Shadow DOM under its own `<sgw-hud>` host** — the dApp's styles and
  `document.querySelector` sweeps never see it, and the wallet's own URI
  scanner skips it.
- **`pointer-events: none` on toasts** — they cannot intercept a click meant
  for the dApp.

## Solana

The same mnemonic derives Solana accounts at `m/44'/501'/i'/0'` (the Phantom /
Solflare path, pinned against the official SLIP-0010 vectors), and the wallet
registers itself through the **Wallet Standard** — so `@solana/wallet-adapter`,
Phantom-aware dApps and friends discover it like a real Solana wallet.

Supported: `standard:connect` / `disconnect` / `events`, `solana:signMessage`,
`solana:signTransaction` (legacy + v0), `solana:signAndSendTransaction`,
and `solana:signIn` (**SIWS**). Cluster defaults to devnet; mainnet is refused
unless `allowMainnet: true`.

## Not just a browser extension — QR / mobile wallets

Some dApps only offer **WalletConnect**: they show a QR code and wait for a
phone to scan it. A browser extension can't answer that. So the package also
ships the *phone side* — a WalletConnect v2 peer that runs in Node and pairs
from the same `wc:` URI the QR encodes:

```sh
# 1. in the browser, ask the page for the URI behind the QR:
#    window.__sgw.findWalletConnectUri()
# 2. hand it to the remote wallet (it approves the session and signs):
SGW_WC_PROJECT_ID=<your-project-id> node bin/sgw.mjs pair "wc:…@2?…" --delay 800
```

Or drive it from a test:

```js
import { RemoteWallet } from "super-ghost-wallet/dist/walletconnect.js";
const wallet = await new RemoteWallet({ projectId, delayMs: 800 }).init();
await wallet.pair(uri);          // session auto-approved
wallet.log;                      // what the dApp asked to sign, decoded
```

`findWalletConnectUri()` scans the light DOM, **shadow roots** (AppKit,
RainbowKit) and clipboard writes, so it works without ever decoding an image.

> Two WalletConnect clients in one process share Core storage — pass distinct
> `storagePrefix` / `customStoragePrefix` values when a test runs both sides.

## Simulating other wallet kinds

| Want to test | Do this |
|---|---|
| A hardware wallet (slow confirm, blind-signing prompt) | `__sgw.setProfile("ledger")` |
| A phone wallet over WalletConnect | `sgw pair <uri>` (above) |
| A dApp that only lists MetaMask / Phantom | `__sgw.impersonate("metamask")` |
| A brand-new user with no history | `__sgw.generateWallet()` |

## Tests

```sh
npm test       # vitest unit tests on the provider (no browser)
npm run e2e    # Playwright: detection, connect, SIWE sign+verify, reject mode,
               # control API, account switch (+ tx test if a dev RPC is on :8545)
```

## Typical agent flow (SIWE auth)

1. Launch browser with the extension flags. Navigate to the dApp.
2. Click the dApp's "Connect wallet" button; pick **Super Ghost Wallet** in the modal
   (or it's auto-picked as the injected provider).
3. The dApp requests `personal_sign` for its SIWE message → auto-signed → the dApp's
   backend verifies and sets the session. The agent is now authenticated.
4. Assert via `__sgw.getLog()` that the expected message was signed.

## Roadmap

- V2: pluggable non-EVM protocols (Canton CIP-0103 `window.canton`, ed25519).
