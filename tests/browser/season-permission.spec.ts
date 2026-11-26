import { expect, test, type Page } from "@playwright/test";

const viewer = {
  id: "user",
  role: "USER",
  email: "viewer@example.invalid",
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
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

test("users browse seasons but request their events one by one", async ({ page }) => {
  const lookups = await seasonPage(page, viewer);
  await expect(page.getByRole("status")).toContainText(
    "Whole seasons are requested by administrators",
  );
  await expect(page.getByRole("button", { name: "Request this season" })).toHaveCount(0);
  expect(lookups).toEqual([]);
});

test("administrators can request whole seasons", async ({ page }) => {
  await seasonPage(page, { ...viewer, role: "ADMIN" });
  await expect(page.getByRole("button", { name: "Request this season" })).toBeVisible();
});

test("the user form explains that only administrators request seasons", async ({ page }) => {
  const writes: unknown[] = [];
  const edited = { ...viewer, id: "11111111-1111-4111-8111-111111111111" };
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
      writes.push(request.postDataJSON());
    }
    return route.fulfill({ json: path.endsWith(`/admin/users/${edited.id}`) ? edited : {} });
  });
  await page.goto(`/admin/users/${edited.id}`);
  const role = page.getByRole("combobox", { name: "Role" });
  await expect(role).toHaveAccessibleDescription(
    "Users request single events. Administrators can also request whole seasons.",
  );
  await expect(page.getByLabel("Can request whole seasons")).toHaveCount(0);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(writes[0]).not.toHaveProperty("canRequestSeasons");
});
