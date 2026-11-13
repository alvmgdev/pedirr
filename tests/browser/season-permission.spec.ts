import { expect, test, type Page } from "@playwright/test";

const viewer = {
  id: "user",
  role: "USER",
  email: "viewer@example.invalid",
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
  canRequestSeasons: false,
};

async function seasonPage(page: Page, user: object) {
  const lookups: string[] = [];
  await page.route("**/api/v1/**", (route) => {
    const url = new URL(route.request().url());
    let body: unknown = {};
    if (url.pathname.endsWith("/auth/me")) {
      body = user;
    } else if (url.pathname.endsWith("/seasons/season-1")) {
      body = { id: "season-1", name: "2026 season" };
    } else if (url.pathname.endsWith("/requests/lookup")) {
      lookups.push(url.search);
      body = { state: "missing" };
    } else if (url.pathname.endsWith("/catalog/events")) {
      body = { items: [], page: 1, totalPages: 1 };
    }
    return route.fulfill({ json: body });
  });
  await page.goto("/catalog/season/season-1");
  await expect(page.getByRole("heading", { name: "2026 season" })).toBeVisible();
  return lookups;
}

test("users without the season grant are offered single events only", async ({ page }) => {
  const lookups = await seasonPage(page, viewer);
  await expect(page.getByRole("status")).toContainText("Your account can request single events");
  await expect(page.getByRole("button", { name: "Request this season" })).toHaveCount(0);
  expect(lookups).toEqual([]);
});

test("granted users and administrators can request whole seasons", async ({ page }) => {
  await seasonPage(page, { ...viewer, canRequestSeasons: true });
  await expect(page.getByRole("button", { name: "Request this season" })).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await seasonPage(page, { ...viewer, role: "ADMIN" });
  await expect(page.getByRole("button", { name: "Request this season" })).toBeVisible();
});

test("administrators choose the season grant when creating and editing users", async ({ page }) => {
  const writes: { method: string; body: unknown }[] = [];
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
    return route.fulfill({ json: {} });
  });
  await page.goto("/admin/users/new");
  const grant = page.getByLabel("Can request whole seasons");
  await expect(grant).not.toBeChecked();
  await page.getByLabel("Email", { exact: true }).fill(created.email);
  await page.getByLabel("Password", { exact: true }).fill("fixture-long-password");
  await grant.check();
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/users/${created.id}$`));
  expect(writes[0]).toMatchObject({ method: "POST", body: { canRequestSeasons: true } });

  const edit = page.getByLabel("Can request whole seasons");
  await expect(edit).toBeChecked();
  await edit.uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(writes[1]).toMatchObject({ method: "PATCH", body: { canRequestSeasons: false } });
});
