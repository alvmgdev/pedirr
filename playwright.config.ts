import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  use: {
    baseURL: "http://127.0.0.1:5173",
    // Dates follow the browser's time zone; a fixed one keeps results the same on every machine.
    timezoneId: "UTC",
    launchOptions: {
      executablePath:
        process.env.CHROMIUM_PATH ?? (process.env.CI ? undefined : "/usr/bin/chromium"),
    },
  },
  webServer: {
    command: "npm run build -w @pedirr/web && npm run preview -w @pedirr/web",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 120000,
  },
  reporter: "list",
});
