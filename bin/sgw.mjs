#!/usr/bin/env node
/**
 * super-ghost-wallet CLI — the "phone" side.
 *
 *   sgw pair <wc:uri>   pair from a QR-code URI and keep signing until Ctrl-C
 *   sgw build           build the extension (dist/)
 *
 * Needs a WalletConnect project id: SGW_WC_PROJECT_ID env or --project-id.
 * Test keys only; real-funds chains are refused.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const cmd = argv[0];

const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

if (cmd === "build") {
  const r = spawnSync("node", [join(ROOT, "build.mjs")], { stdio: "inherit", cwd: ROOT });
  process.exit(r.status ?? 0);
}

if (cmd !== "pair") {
  console.log(`super-ghost-wallet

  sgw pair <wc:uri> [--project-id ID] [--delay MS] [--account N] [--reject]
      Act as a remote (QR-scanned) wallet: pair with the URI a dApp's connect
      modal shows, then auto-approve the session and sign its requests.
      Get the URI from the page with:  window.__sgw.findWalletConnectUri()

  sgw build
      Build the browser extension into dist/.
`);
  process.exit(cmd ? 1 : 0);
}

const uri = argv[1];
const projectId = flag("project-id", process.env.SGW_WC_PROJECT_ID);
if (!uri?.startsWith("wc:")) {
  console.error("sgw pair: expected a wc: URI as the first argument");
  process.exit(1);
}
if (!projectId) {
  console.error(
    "sgw pair: a WalletConnect project id is required (SGW_WC_PROJECT_ID or --project-id).\n" +
      "Create one at https://dashboard.reown.com — it must be usable with the dApp's relay.",
  );
  process.exit(1);
}

const { RemoteWallet } = await import(join(ROOT, "dist/walletconnect.js")).catch(() => {
  console.error("sgw: dist/ missing or stale — run `sgw build` first.");
  process.exit(1);
});

const wallet = await new RemoteWallet({
  projectId,
  delayMs: Number(flag("delay", 0)),
  accountIndex: Number(flag("account", 0)),
  mode: argv.includes("--reject") ? "reject" : "auto",
  onRequest: (e) =>
    console.log(
      `[${e.status}] ${e.method}${e.decoded ? ` — ${e.decoded.slice(0, 120).replace(/\n/g, " ⏎ ")}` : ""}`,
    ),
}).init();

console.log(`wallet ready
  evm    ${wallet.address}
  solana ${wallet.solanaAddress}
pairing…`);

await wallet.pair(uri);
console.log("session established — signing requests until Ctrl-C");

const bye = async () => {
  await wallet.close();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
