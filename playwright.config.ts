import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: 0,
  reporter: [["list"]],
  webServer: {
    command: "node demo/serve.mjs",
    port: 5199,
    reuseExistingServer: true,
  },
  use: { baseURL: "http://127.0.0.1:5199" },
});
