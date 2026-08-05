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
