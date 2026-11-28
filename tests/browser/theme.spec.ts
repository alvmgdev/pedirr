import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const user = {
  id: "u1",
  email: "viewer@example.invalid",
  role: "USER",
  active: true,
  locale: "en",
  theme: "dark",
  timezone: "UTC",
  autoApprove: null,
  weeklyRequestLimit: null,
  expiresAt: null,
  plan: null,
  tenantId: "platform",
  tenant: { code: null, name: "Pedirr" },
};

async function fixtures(page: Page, saved: { theme: string }) {
  const writes: unknown[] = [];
  await page.route("**/api/v1/**", (route) => {
    const call = route.request();
    const path = new URL(call.url()).pathname;
    if (path.endsWith("/auth/me")) {
      return route.fulfill({ json: { ...user, theme: saved.theme } });
    }
    if (path.endsWith("/auth/csrf")) {
      return route.fulfill({ json: { token: "fixture-token" } });
    }
    if (path.endsWith("/me") && call.method() === "PATCH") {
      const body = call.postDataJSON() as { theme: string };
      writes.push(body);
      saved.theme = body.theme;
      return route.fulfill({ json: { ...user, theme: body.theme } });
    }
    if (path.endsWith("/issues/open")) {
      return route.fulfill({ json: { open: 0, awaiting: 0 } });
    }
    return route.fulfill({ json: { items: [], total: 0, page: 1, hasMore: false } });
  });
  return writes;
}
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);

test("the theme menu switches, saves and keeps the colour theme", async ({ page }) => {
  const saved = { theme: "dark" };
  const writes = await fixtures(page, saved);
  await page.goto("/requests");
  expect(await theme(page)).toBe("dark");
  const menu = page.getByRole("button", { name: "Theme: Dark" });
  await menu.click();
  await page.getByRole("button", { name: "Light" }).click();
  await expect.poll(() => theme(page)).toBe("light");
  expect(writes).toEqual([{ theme: "light" }]);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f6f4ef");
  // A reload paints light straight away, before the app loads.
  await page.reload();
  await expect.poll(() => theme(page)).toBe("light");
  await expect(page.getByRole("button", { name: "Theme: Light" })).toBeVisible();
});

test("the system choice follows the device", async ({ page }) => {
  const saved = { theme: "system" };
  await fixtures(page, saved);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/requests");
  await expect.poll(() => theme(page)).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => theme(page)).toBe("dark");
  await expect(page.getByRole("button", { name: "Theme: Same as the system" })).toBeVisible();
});

test("the sign-in page offers the theme too, and light pages keep their contrast", async ({
  page,
}) => {
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/me")) {
      return route.fulfill({ status: 401, json: {} });
    }
    return route.fulfill({ json: { registrationEnabled: false, environment: null } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Theme: Dark" }).click();
  await page.getByRole("button", { name: "Light" }).click();
  await expect.poll(() => theme(page)).toBe("light");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
    .analyze();
  expect(results.violations.map((item) => item.id)).toEqual([]);
});
