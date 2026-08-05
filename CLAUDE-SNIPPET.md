# Paste this block into your dApp's CLAUDE.md

```markdown
## Wallet testing (Super Ghost Wallet)

This project is tested with Super Ghost Wallet, a headless auto-signing test wallet
(~/Documents/super-ghost-wallet). To test wallet-gated UI (connect, SIWE auth, txs):

1. Launch the MCP browser with:
   --disable-extensions-except=/Users/<you>/Documents/super-ghost-wallet/dist
   --load-extension=/Users/<you>/Documents/super-ghost-wallet/dist
2. The wallet appears as "Super Ghost Wallet" (EIP-6963) and as window.ethereum.
   Connect flows and signatures auto-approve — no popup, no human needed.
3. Default account: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (anvil #0),
   chain 31337, RPC http://127.0.0.1:8545.
4. Control from page context via evaluate_script:
   - window.__sgw.getState() / getLog()   — inspect what was signed
   - window.__sgw.setMode('reject')       — test user-rejection paths (4001)
   - window.__sgw.useAccount(i) / setChain(id, rpcUrl)
5. Test keys only. Mainnet chain ids are refused by design.
```
