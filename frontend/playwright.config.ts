import { defineConfig } from "@playwright/test";

const externalURL = process.env.ITLES_E2E_BASE_URL;
const baseURL = externalURL ?? "http://127.0.0.1:3100";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)) {
  throw new Error(
    "E2E creates synthetic companies; use a private loopback server only.",
  );
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "../.hoplite/artifacts/e2e",
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    locale: "ru-RU",
    timezoneId: "UTC",
    actionTimeout: 10_000,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: externalURL
    ? undefined
    : {
        command: "npm run build && ../.venv/bin/python e2e/server.py",
        url: `${baseURL}/api/health`,
        reuseExistingServer: false,
        gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
        timeout: 120_000,
      },
});
