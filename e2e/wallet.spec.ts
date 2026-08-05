import { test as base, chromium, expect, type BrowserContext } from "@playwright/test";
import { verifyMessage } from "viem";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const ANVIL0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const test = base.extend<{ context: BrowserContext }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium", // new headless supports MV3 extensions
      headless: true,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
      ],
    });
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    await use(await context.newPage());
  },
});

declare global {
  interface Window {
    __sgw: {
      getState(): Record<string, unknown>;
      getLog(): { method: string; status: string; decoded?: { kind: string; summary: string } }[];
      setMode(mode: string): string;
      useAccount(i: number): string;
      setPolicy(p: Record<string, string>): Record<string, string>;
      clearPolicies(): string;
      failNext(method: string, code?: number, message?: string): string;
      setDelay(ms: number): number;
      waitForRequest(method: string): Promise<{ method: string; status: string }>;
      simulateDisconnect(): void;
      hud(on?: boolean | Record<string, unknown>): Record<string, unknown>;
      say(text: string, detail?: string): string;
    };
    ethereum?: { isSuperGhostWallet?: boolean };
  }
}

test("announces via EIP-6963 and window.ethereum", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#providers")).toHaveText(/Super Ghost Wallet/);
  expect(await page.evaluate(() => window.ethereum?.isSuperGhostWallet)).toBe(true);
});

test("connects with the default anvil account", async ({ page }) => {
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#account")).toHaveText(ANVIL0);
});

test("SIWE-style personal_sign yields a verifiable signature", async ({ page }) => {
  await page.goto("/");
  await page.click("#connect");
  await page.click("#sign");
  const sig = (await page.locator("#sig").textContent()) as `0x${string}`;
  const message = (await page.locator("#msg").textContent())!;
  expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  expect(await verifyMessage({ address: ANVIL0, message, signature: sig })).toBe(true);
});

test("reject mode surfaces EIP-1193 4001 to the dApp", async ({ page }) => {
  await page.goto("/");
  await page.click("#connect");
  await page.evaluate(() => window.__sgw.setMode("reject"));
  await page.click("#sign");
  await expect(page.locator("#error")).toHaveText(/4001.*rejected/);
  await page.evaluate(() => window.__sgw.setMode("auto"));
  await page.click("#sign");
  await expect(page.locator("#sig")).toHaveText(/^0x[0-9a-f]{130}$/);
});

test("control API exposes state and request log", async ({ page }) => {
  await page.goto("/");
  await page.click("#connect");
  await page.click("#sign");
  const state = await page.evaluate(() => window.__sgw.getState());
  expect(state.activeAccount).toBe(ANVIL0);
  expect(state.chainId).toBe(31337);
  // secrets never leak through the control API
  expect(state).not.toHaveProperty("mnemonic");
  expect(state).not.toHaveProperty("privateKeys");
  const log = await page.evaluate(() => window.__sgw.getLog());
  expect(log.map((e) => [e.method, e.status])).toEqual([
    ["eth_requestAccounts", "approved"],
    ["personal_sign", "approved"],
  ]);
});

test("account switching via control API", async ({ page }) => {
  await page.goto("/");
  await page.click("#connect");
  const addr = await page.evaluate(() => window.__sgw.useAccount(1));
  expect(addr).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
});

test("failNext injects a one-shot error surfaced to the dApp", async ({ page }) => {
  await page.goto("/");
  await page.click("#connect");
  await page.evaluate(() => window.__sgw.failNext("personal_sign", 4902, "injected"));
  await page.click("#sign");
  await expect(page.locator("#error")).toHaveText(/4902 injected/);
  await page.click("#sign"); // recovered on the next attempt
  await expect(page.locator("#sig")).toHaveText(/^0x[0-9a-f]{130}$/);
});

test("per-method policy rejects only the targeted method", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() =>
    window.__sgw.setPolicy({ personal_sign: "reject" }),
  );
  await page.click("#connect"); // eth_requestAccounts unaffected
  await expect(page.locator("#account")).toHaveText(ANVIL0);
  await page.click("#sign");
  await expect(page.locator("#error")).toHaveText(/4001.*rejected/);
  await page.evaluate(() => window.__sgw.clearPolicies());
});

test("waitForRequest resolves with the decoded SIWE entry", async ({ page }) => {
  await page.goto("/");
  await page.click("#connect");
  const [entry] = await Promise.all([
    page.evaluate(() => window.__sgw.waitForRequest("personal_sign")),
    page.click("#sign"),
  ]);
  expect(entry.status).toBe("approved");
  const log = await page.evaluate(() => window.__sgw.getLog());
  expect(log.at(-1)?.decoded?.kind).toBe("siwe");
});

test("HUD narrates wallet activity in the page", async ({ page }) => {
  await page.goto("/");
  // absent until asked for
  expect(await page.locator("sgw-hud").count()).toBe(0);

  await page.evaluate(() => window.__sgw.hud(true));
  await page.evaluate(() => window.__sgw.say("Connecting wallet", "agent clicked Connect"));
  await page.click("#connect");
  await page.click("#sign");

  const hud = page.locator("sgw-hud");
  await expect(hud.locator(".panel-head .title")).toHaveText("Super Ghost Wallet");
  // one row for the narration + one per wallet action
  await expect(hud.locator(".row")).toHaveCount(3);
  await expect(hud.locator(".row .title").nth(1)).toHaveText("Connect");
  await expect(hud.locator(".row .title").nth(2)).toHaveText("Sign-in (SIWE)");
  await expect(hud.locator(".toast").first()).toBeVisible();
  // let the capsule finish stretching before the screenshot artifact
  await expect(hud.locator(".toast").first()).toHaveAttribute("data-open", "true");
  await page.waitForTimeout(450);
  await page.screenshot({ path: "test-results/hud.png" });

  // the dApp keeps working with the overlay up: toasts don't eat clicks
  await page.evaluate(() => window.__sgw.hud({ position: "top-right" }));
  await page.click("#sign");
  await expect(hud.locator(".row")).toHaveCount(4);

  await page.evaluate(() => window.__sgw.hud(false));
  await expect(page.locator("sgw-hud")).toHaveCount(0);
});

test("HUD shows rejections distinctly", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.__sgw.hud(true));
  await page.click("#connect");
  await page.evaluate(() => window.__sgw.setMode("reject"));
  await page.click("#sign");
  const toast = page.locator("sgw-hud .toast").last();
  await expect(toast).toHaveAttribute("data-status", "rejected");
  await expect(toast.locator(".title")).toContainText("rejected");
  await expect(page.locator("sgw-hud .row .dot").last()).toHaveAttribute(
    "data-status",
    "rejected",
  );
  await page.evaluate(() => window.__sgw.setMode("auto"));
});

// Requires a local anvil (or any dev RPC) on 127.0.0.1:8545.
test("eth_sendTransaction lands on a dev RPC when available", async ({ page }) => {
  const anvilUp = await fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  }).then((r) => r.ok).catch(() => false);
  test.skip(!anvilUp, "no dev RPC on 127.0.0.1:8545");

  await page.goto("/");
  await page.click("#connect");
  await page.click("#tx");
  await expect(page.locator("#txhash")).toHaveText(/^0x[0-9a-f]{64}$/);
});
