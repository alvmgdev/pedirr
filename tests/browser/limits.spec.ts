import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const viewer = {
  id: "user",
  role: "USER",
  email: "viewer@example.invalid",
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
  tenantId: "platform",
  tenant: { code: null, name: "Pedirr" },
  weeklyRequestLimit: null,
  expiresAt: null,
};

test("administrators switch the weekly limit and expiration on and off", async ({ page }) => {
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  const created = { ...viewer, id: "11111111-1111-4111-8111-111111111111" };
  await page.route("**/api/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/me")) {
      return route.fulfill({ json: { ...viewer, id: "admin", role: "ADMIN" } });
    }
    if (path.endsWith("/auth/csrf")) {
      return route.fulfill({ json: { token: "fixture-token" } });
    }
    if (request.method() !== "GET") {
      writes.push({ method: request.method(), body: request.postDataJSON() });
      Object.assign(created, request.postDataJSON());
    }
    if (path.endsWith("/admin/users") || path.endsWith(`/admin/users/${created.id}`)) {
      return route.fulfill({ json: created });
    }
    return route.fulfill({ json: path.endsWith("/admin/plans") ? [] : {} });
  });
  await page.goto("/admin/users/new");
  const weekly = page.getByRole("checkbox", { name: "Weekly request limit" });
  const expiry = page.getByRole("checkbox", { name: "Expiration date" });
  // Both start off, which means no limit and no expiration, and say so.
  await expect(weekly).not.toBeChecked();
  await expect(expiry).not.toBeChecked();
  await expect(weekly).toHaveAccessibleDescription(/as many requests as they want/);
  await expect(expiry).toHaveAccessibleDescription(/never expires/);
  await expect(page.getByLabel("Requests per week")).toHaveCount(0);

  await page.getByLabel("Email", { exact: true }).fill(created.email);
  await page.getByLabel("Password", { exact: true }).fill("fixture-long-password");
  await weekly.check();
  await expect(weekly).toHaveAccessibleDescription(/last 7 days/);
  const count = page.getByLabel("Requests per week");
  await expect(count).toHaveAttribute("required", "");
  await count.fill("5");
  await expiry.check();
  await page.getByLabel("Expires at the end of").fill("2026-12-31");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
    .analyze();
  expect(results.violations.map((item) => item.id)).toEqual([]);
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/users/${created.id}$`));
  expect(writes[0].body).toMatchObject({ weeklyRequestLimit: 5 });
  // The end of the chosen day in the administrator's time zone: the browser's, UTC in these tests.
  const expiresAt = new Date(String(writes[0].body.expiresAt));
  expect([expiresAt.getUTCFullYear(), expiresAt.getUTCMonth(), expiresAt.getUTCDate()]).toEqual([
    2026, 11, 31,
  ]);
  expect([expiresAt.getUTCHours(), expiresAt.getUTCMinutes()]).toEqual([23, 59]);

  // Editing shows the saved values; switching a limit off removes it.
  await expect(page.getByRole("checkbox", { name: "Weekly request limit" })).toBeChecked();
  await expect(page.getByLabel("Requests per week")).toHaveValue("5");
  await expect(page.getByLabel("Expires at the end of")).toHaveValue("2026-12-31");
  await page.getByRole("checkbox", { name: "Weekly request limit" }).uncheck();
  await page.getByRole("checkbox", { name: "Expiration date" }).uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(writes[1].body).toMatchObject({ weeklyRequestLimit: null, expiresAt: null });
});

test("users see what is left of their weekly limit", async ({ page }) => {
  const limited = { ...viewer, weeklyRequestLimit: 2, expiresAt: "2027-01-31T22:59:59.999Z" };
  const quota = { limit: 2, used: 2, remaining: 0, resetsAt: "2026-12-01T10:30:00.000Z" };
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path.endsWith("/auth/me")) {
      body = limited;
    } else if (path.endsWith("/requests/quota")) {
      body = quota;
    } else if (path.endsWith("/catalog/events/event-1")) {
      body = { id: "event-1", name: "A vs B" };
    } else if (path.endsWith("/requests/lookup")) {
      body = { state: "missing" };
    } else if (path.endsWith("/requests/parts")) {
      body = { supported: false, parts: [] };
    }
    return route.fulfill({ json: body });
  });
  await page.goto("/catalog/event/event-1");
  await expect(page.getByText("0 of 2 requests left this week")).toBeVisible();
  await expect(page.getByText("Your next request frees up on Dec 1, 2026")).toBeVisible();
  await expect(page.getByRole("button", { name: "Request this event" })).toBeDisabled();

  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Your limits" })).toBeVisible();
  await expect(page.getByText("0 of 2 requests left this week")).toBeVisible();
  await expect(page.getByText("Your account expires on Jan 31, 2027")).toBeVisible();
});

test("an account without limits says so", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const unlimited = { limit: null, used: 0, remaining: null, resetsAt: null };
    return route.fulfill({
      json: path.endsWith("/auth/me") ? viewer : path.endsWith("/requests/quota") ? unlimited : {},
    });
  });
  await page.goto("/account");
  await expect(page.getByText("You can make as many requests as you want.")).toBeVisible();
  await expect(page.getByText("Your account does not expire.")).toBeVisible();
});
