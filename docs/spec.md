# Super Ghost Wallet — design spec (2026-08-05)

## Problem

Agent-driven browser testing (Claude via playwright MCP / chrome-devtools MCP) cannot test
dApp flows that require a wallet: extension popups (MetaMask & co.) live outside the page,
so the agent can never click "Approve" on connect / signature / transaction prompts.
Result: any UI behind wallet-signature auth (SIWE etc.) is untestable by the agent.

## Solution

A headless Chrome MV3 extension that IS the wallet. It announces itself via EIP-6963
(plus legacy `window.ethereum`) so wagmi / RainbowKit / AppKit / ConnectKit detect it like
a real wallet, and it signs automatically with well-known test keys. Zero changes needed
in the dApp under test. The agent drives the browser as usual and controls the wallet
through an in-page API (`window.__sgw`) via `evaluate_script`.

## Architecture

- **MV3 extension, no UI.** Loaded with `--load-extension` into the browser the agent
  already controls.
- **`content.js`** (ISOLATED world): bridges `chrome.storage.local` (persistent config)
  to the page via `window.postMessage`.
- **`inpage.js`** (MAIN world, `document_start`): the wallet itself.
  - EIP-6963 announce + `window.ethereum`.
  - EIP-1193 `request()` implemented with viem local accounts (mnemonic / imported keys).
  - Handled: `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `net_version`,
    `personal_sign`, `eth_signTypedData_v4` (+v3), `eth_sendTransaction`,
    `wallet_switchEthereumChain`, `wallet_addEthereumChain`, `wallet_*Permissions`.
  - Everything else → JSON-RPC passthrough to the configured RPC URL.
- **Control API** `window.__sgw`:
  - `getState()`, `getLog()`, `clearLog()`
  - `useAccount(i)`, `importKey(pk)`, `setChain(id, rpcUrl?)`
  - `setMode('auto' | 'reject' | 'queue')`, `pending()`, `approve(id)`, `deny(id)`
  - `reject` mode returns EIP-1193 error 4001 on sensitive methods → error-path testing.
  - Log records every request (method, params, status, result) → agent can assert what
    the dApp asked to sign.

## Safety

- Defaults: anvil mnemonic (`test test … junk`), chain 31337, RPC `127.0.0.1:8545`.
- Known mainnet chain ids (1, 10, 56, 137, 8453, 42161, 43114, …) are refused unless
  `allowMainnet: true`. Test keys only; never real funds.

## Deliverables

```
super-ghost-wallet/
  src/           # provider, control API, inpage entry, content bridge
  demo/          # minimal SIWE-style dApp for e2e
  e2e/           # Playwright: detection, connect, sign+verify, reject mode, (tx if anvil up)
  test/          # vitest unit tests on the provider (no chrome dependency)
  README.md      # setup for playwright MCP / chrome-devtools MCP
  CLAUDE-SNIPPET.md  # block to paste into a dApp's CLAUDE.md
```

## Out of scope (V1) / V2

- Canton CIP-0103 provider (`window.canton`, ed25519) — architecture keeps the
  provider pluggable so this lands as a second inpage module.
- WalletConnect relay pairing (extension covers the injected path only).
- Hardware-wallet-style manual approval UI.
