---
name: super-ghost-wallet
description: Test wallet-gated dApp UIs (connect, SIWE/signature auth, typed-data, transactions) with a headless auto-signing wallet — no human wallet popups. Use whenever a dApp flow needs a connected wallet or a signature to proceed: "test the login", "connect a wallet", "test with authentication", "the UI needs a signature". Works with wagmi, RainbowKit, Reown AppKit, ConnectKit via EIP-6963.
---

# Super Ghost Wallet — headless test wallet for dApp UI testing

A Chrome MV3 extension that IS the wallet: it announces itself via EIP-6963 (plus
legacy `window.ethereum`), auto-signs with well-known TEST keys, and is controlled
from page context. The dApp under test needs **zero changes**.

## 1 · Build once

The extension source ships with this plugin. Build it if `dist/` is missing:

```sh
cd "${CLAUDE_PLUGIN_ROOT}" && npm install && npm run build
```

`npm run build` produces `dist/` — the loadable extension.

## 2 · Launch a browser with the wallet

Any Chromium with these flags has the wallet in every page (headless works —
new headless supports MV3):

```
--disable-extensions-except=${CLAUDE_PLUGIN_ROOT}/dist
--load-extension=${CLAUDE_PLUGIN_ROOT}/dist
```

- **Playwright script** (recommended — full control):
  `chromium.launchPersistentContext("", { channel: "chromium", headless: true, args: [<the two flags>] })`
- **playwright MCP / chrome-devtools MCP**: pass the flags through the MCP's
  browser-args config if the session's MCP supports it; otherwise script it.
- A complete example (connect → SIWE sign → verify → rejection path):
  `${CLAUDE_PLUGIN_ROOT}/examples/siwe-flow.mjs`.

## 3 · Drive the flow

1. Navigate to the dApp. Click its "Connect wallet" button; pick **Super Ghost
   Wallet** in the wallet list (or it's used directly as the injected provider).
2. Connect, signature and transaction requests auto-approve. SIWE-style auth
   completes without any prompt.
3. Default identity: anvil account #0 `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`,
   chain 31337, RPC `http://127.0.0.1:8545`.

## 4 · Control API — `window.__sgw` (via evaluate in page context)

```js
__sgw.getState()                  // accounts, activeAccount, chainId, mode… (never secrets)
__sgw.getLog()                    // every sensitive request: method, params, status, result
__sgw.useAccount(i)               // switch account (anvil #0..#9)
__sgw.importKey("0x…")            // add a raw TEST private key
__sgw.setChain(id, rpcUrl?)       // switch / add chain
__sgw.setMode("auto"|"reject"|"queue")
__sgw.pending() / .approve(id) / .deny(id)   // queue mode
__sgw.configure({ chainId, allowMainnet, autoConnect, … })
__sgw.setPolicy({ eth_sendTransaction: "reject" })  // per-method override
__sgw.failNext("personal_sign", 4902)        // one-shot error injection
__sgw.setDelay(1500)                         // latency — test loading states
await __sgw.waitForRequest("personal_sign")  // sync on the next settled request
__sgw.simulateDisconnect()                   // test reconnection paths
```

```js
__sgw.generateWallet(5)       // fresh RANDOM test wallet (EVM + Solana), mnemonic returned once
__sgw.impersonate("metamask") // dApp only lists MetaMask/Phantom? become it
__sgw.setProfile("ledger")    // hardware wallet: ~3s confirm + blind signing OFF (0x6985)
__sgw.enableBlindSigning()
__sgw.findWalletConnectUri()  // the wc: URI behind a QR code
```

## 5 · Other wallet kinds

- **Solana**: the same mnemonic derives `m/44'/501'/i'/0'` accounts and the
  wallet registers via **Wallet Standard** — `@solana/wallet-adapter` dApps
  discover it. Supports signMessage / signTransaction / signAndSend / **SIWS**.
  Devnet by default; mainnet refused unless `allowMainnet: true`.
- **QR / mobile (WalletConnect)**: when a dApp only offers a QR code, an
  extension cannot answer. Get the URI in-page with
  `__sgw.findWalletConnectUri()` (scans DOM, shadow roots, clipboard), then run
  the Node-side peer that pairs with it:
  `SGW_WC_PROJECT_ID=<id> node ${CLAUDE_PLUGIN_ROOT}/bin/sgw.mjs pair "<uri>"`
  (or `import { RemoteWallet } from "…/dist/walletconnect.js"` in a test).
  Requires a WalletConnect Cloud project id.
- **Hardware (Ledger)**: `setProfile("ledger")` adds a multi-second device
  confirmation and turns blind signing OFF, so EIP-712 and calldata
  transactions fail with the real `0x6985` error until `enableBlindSigning()`.

`getLog()` entries include `decoded`: UTF-8 text, parsed SIWE fields
(domain/nonce/address), or `EIP-712 <primaryType>` — assert on meaning, not hex.
`sgw:request` CustomEvents fire on `window` for observation without polling.

- **Assert what was signed** with `getLog()` — verify the dApp requested the
  expected message, not just that the UI moved on.
- **Test rejection paths** with `setMode("reject")` — sensitive methods then
  return EIP-1193 error 4001, exactly like a user clicking "Reject".

## Gotchas

- **Configure BEFORE the dApp connects**: `configure()` persists via
  `chrome.storage`; set chain/account on a first page load, then reload so the
  dApp sees the final state from the start.
- **Mainnet-configured dApps** (AppKit/wagmi set to chain 1, Base, Arbitrum…):
  the wallet refuses real-funds chain ids by default. For signature-only auth
  it is safe to override: `__sgw.configure({ chainId: 1, allowMainnet: true })`.
  Never import a key holding real funds.
- **Duplicate DOM copies** (desktop + mobile variants of the same modal): a
  `.first()` fill can hit the hidden copy. Target the element that is actually
  on top (`document.elementFromPoint`) — see the example script.
- `eth_sign` is disabled by design (legacy footgun); dApps should use
  `personal_sign` / `eth_signTypedData_v4`.
