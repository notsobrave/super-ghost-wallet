#!/usr/bin/env node
// Generic agent-driven flow against the bundled demo dApp:
// connect → SIWE-style personal_sign → verify → rejection path.
// Run: node demo/serve.mjs &  then  node examples/siwe-flow.mjs
import { chromium } from "@playwright/test";
import { verifyMessage } from "viem";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = process.env.APP_URL ?? "http://127.0.0.1:5199";

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${ROOT}/dist`,
    `--load-extension=${ROOT}/dist`,
  ],
});
const page = await ctx.newPage();

try {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__sgw);

  // connect + sign — auto-approved, no popup
  await page.click("#connect");
  const address = (await page.locator("#account").textContent())?.trim();
  await page.click("#sign");
  const signature = await page.locator("#sig").textContent();
  const message = await page.locator("#msg").textContent();
  const ok = await verifyMessage({ address, message, signature });
  console.log("connected:", address);
  console.log("signature verifies:", ok);

  // assert on MEANING via the decoded log, not hex
  const last = await page.evaluate(() => window.__sgw.getLog().at(-1));
  console.log("decoded:", last.decoded?.kind, "—", last.decoded?.summary);

  // rejection path — EIP-1193 4001, like a user clicking "Reject"
  await page.evaluate(() => window.__sgw.setMode("reject"));
  await page.click("#sign");
  console.log("rejection surfaced:", await page.locator("#error").textContent());
} finally {
  await ctx.close();
}
