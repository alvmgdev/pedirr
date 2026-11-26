import { expect, test, type Page } from "@playwright/test";

const client = {
  id: "client-1",
  role: "USER",
  email: "client@example.invalid",
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
  weeklyRequestLimit: null,
  expiresAt: null,
  plan: null,
  tenant: { code: "k7x2p", name: "Fight Club TV" },
};

/** Serves a reseller's API; records every API path the page calls. */
async function reseller(page: Page, environment: object | null, status = 200) {
  const calls: string[] = [];
  let signedIn = false;
  await page.route("**/api/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push(path);
    if (path.endsWith("/auth/config")) {
      return status === 404
        ? route.fulfill({ status, json: { code: "TENANT_NOT_FOUND" } })
        : route.fulfill({ json: { registrationEnabled: false, environment } });
    }
    if (path.endsWith("/auth/me")) {
      if (status === 404) {
        return route.fulfill({ status, json: { code: "TENANT_NOT_FOUND" } });
      }
      return signedIn
        ? route.fulfill({ json: client })
        : route.fulfill({ status: 401, json: { code: "UNAUTHORIZED" } });
    }
    if (path.endsWith("/auth/csrf")) {
      return route.fulfill({ json: { token: "fixture-token" } });
    }
    if (path.endsWith("/auth/login") || path.endsWith("/me")) {
      signedIn = true;
      return route.fulfill({ json: client });
    }
    return route.fulfill({ json: { items: [], total: 0, page: 1, open: 0 } });
  });
  return calls;
}

test("a reseller's address signs in to that reseller and stays under its path", async ({
  page,
}) => {
  const calls = await reseller(page, { code: "k7x2p", name: "Fight Club TV", active: true });
  await page.goto("/k7x2p/");
  await expect(page.getByText("Fight Club TV", { exact: true })).toBeVisible();
  // Resellers create their clients' accounts: no registration option.
  await expect(page.getByRole("button", { name: "Create account" })).toHaveCount(0);
  await page.getByLabel("Email").fill(client.email);
  await page.getByLabel("Password").fill("a-long-enough-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Requests" }).first().click();
  await expect(page).toHaveURL(/\/k7x2p\/requests$/);
  // Every call went to the reseller's API, never the platform's.
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((path) => path.startsWith("/k7x2p/api/v1/"))).toBe(true);
});

test("an address that is no service says so instead of showing a sign-in form", async ({
  page,
}) => {
  await reseller(page, null, 404);
  await page.goto("/zzzzz/");
  await expect(page.getByRole("alert")).toContainText("This address does not exist");
  await expect(page.getByLabel("Password")).toHaveCount(0);
});

test("a disabled reseller explains that it is not available", async ({ page }) => {
  await reseller(page, { code: "k7x2p", name: "Fight Club TV", active: false });
  await page.goto("/k7x2p/");
  await expect(page.getByRole("alert")).toContainText("Fight Club TV is not available right now");
  await expect(page.getByLabel("Password")).toHaveCount(0);
});
