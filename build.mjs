#!/usr/bin/env node
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  target: "chrome120",
  logLevel: "info",
  minify: false,
};

await Promise.all([
  build({ ...common, entryPoints: ["src/inpage.ts"], outfile: "dist/inpage.js" }),
  build({ ...common, entryPoints: ["src/content.ts"], outfile: "dist/content.js" }),
  // Node-side remote ("QR-scanned") wallet — ESM, not part of the extension.
  build({
    entryPoints: ["src/walletconnect.ts"],
    outfile: "dist/walletconnect.js",
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "info",
  }),
  cp("manifest.json", "dist/manifest.json"),
]);

console.log("dist/ ready — load with --load-extension=" + process.cwd() + "/dist");
