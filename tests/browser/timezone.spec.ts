import { expect, test } from "@playwright/test";

// A browser in New York, for an account last signed in from Madrid.
test.use({ timezoneId: "America/New_York" });

const viewer = {
  id: "user",
  role: "USER",
  email: "viewer@example.invalid",
  active: true,
  locale: "en",
  timezone: "Europe/Madrid",
  autoApprove: null,
  tenantId: "platform",
  tenant: { code: null, name: "Pedirr" },
  weeklyRequestLimit: 3,
  expiresAt: null,
  plan: null,
};

test("dates follow the browser's time zone without asking or saving it", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${path}`);
    }
    if (path.endsWith("/auth/me")) {
      return route.fulfill({ json: viewer });
    }
    if (path.endsWith("/auth/csrf")) {
      return route.fulfill({ json: { token: "fixture-token" } });
    }
    if (path.endsWith("/requests/quota")) {
      return route.fulfill({
        json: { limit: 3, used: 3, remaining: 0, resetsAt: "2026-11-30T15:00:00Z" },
      });
    }
    return route.fulfill({ json: { items: [], total: 0, open: 0 } });
  });
  await page.goto("/account");
  await expect(
    page.getByText("Dates and times follow this device's time zone: America/New_York."),
  ).toBeVisible();
  // 15:00 UTC is 10:00 in New York (16:00 in Madrid, the saved zone).
  await expect(page.getByRole("status").filter({ hasText: "frees up" })).toContainText("10:00");
  await expect(page.getByLabel("Timezone")).toHaveCount(0);
  await expect(page.getByText("Dates and times in America/New_York").first()).toBeVisible();
  expect(writes).toEqual([]);
});
