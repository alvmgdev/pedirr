import { expect, test, type Page } from "@playwright/test";

const admin = {
  id: "admin",
  email: "admin@example.invalid",
  role: "ADMIN",
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
  canRequestSeasons: true,
};
const event = {
  id: "ufc-1",
  name: "UFC 332 Silva vs Wang",
  leagueName: "UFC",
  leagueId: "ufc",
  sportName: "Combat",
  scheduledStart: "2026-10-03T22:00:00Z",
};
const partOptions = {
  supported: true,
  parts: [
    { name: "Early Prelims", optional: false, selected: true, state: "none" },
    { name: "Prelims", optional: false, selected: true, state: "requested" },
    { name: "Main Card", optional: false, selected: true, state: "available" },
    { name: "Post Show", optional: true, selected: false, state: "none" },
  ],
};
const request = {
  id: "request-1",
  status: "AVAILABLE",
  version: 3,
  createdAt: "2026-10-04T10:00:00Z",
  integrationState: "synced",
  entity: { title: event.name },
  scope: { kind: "event", event, league: { id: "ufc", name: "UFC" } },
  _count: { subscribers: 2 },
  parts: [
    { name: "Main Card", status: "APPROVED", rejectionReason: null },
    { name: "Prelims", status: "PENDING", rejectionReason: null },
    { name: "Early Prelims", status: "REJECTED", rejectionReason: "Not released" },
  ],
  subscription: { parts: ["Main Card"], status: "AVAILABLE" },
  history: [],
  events: [
    {
      id: "request-event-1",
      metadata: event,
      available: true,
      progress: 100,
      parts: ["Early Prelims", "Prelims", "Main Card", "Post Show"],
      availableParts: ["Main Card"],
      downloadingParts: [],
    },
  ],
};

async function fixtures(page: Page, user = admin) {
  const posts: unknown[] = [];
  await page.route("**/api/v1/**", (route) => {
    const call = route.request();
    const path = new URL(call.url()).pathname;
    if (path.endsWith("/auth/me")) {
      return route.fulfill({ json: user });
    }
    if (path.endsWith("/auth/csrf")) {
      return route.fulfill({ json: { token: "fixture-token" } });
    }
    if (path.endsWith("/catalog/events/ufc-1")) {
      return route.fulfill({ json: event });
    }
    if (path.endsWith("/requests/lookup")) {
      return route.fulfill({ json: { state: "missing" } });
    }
    if (path.endsWith("/requests/parts")) {
      return route.fulfill({ json: partOptions });
    }
    if (path.endsWith("/requests") && call.method() === "POST") {
      posts.push(call.postDataJSON());
      return route.fulfill({ json: { created: true, request } });
    }
    if (path.endsWith("/requests/request-1")) {
      return route.fulfill({ json: request });
    }
    return route.fulfill({ json: {} });
  });
  return posts;
}

test("requesting a fight card asks for its parts with Sportarr's defaults", async ({ page }) => {
  const posts = await fixtures(page);
  await page.goto("/catalog/event/ufc-1");
  await page.getByRole("button", { name: "Request this event" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose parts" });
  await expect(dialog).toBeVisible();
  const option = (name: string) => dialog.getByRole("checkbox", { name, exact: true });
  await expect(option("Early Prelims")).toBeChecked();
  await expect(option("Prelims")).toBeChecked();
  await expect(dialog.getByText("Already requested", { exact: true })).toBeVisible();
  await expect(option("Main Card")).toBeDisabled();
  await expect(dialog.getByText("In the library", { exact: true })).toBeVisible();
  await expect(option("Post Show")).not.toBeChecked();
  await expect(dialog.getByText("Optional", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/parts-dialog-desktop.png" });

  await option("Early Prelims").uncheck();
  const confirm = dialog.getByRole("button", { name: "Request 1 part" });
  await option("Prelims").uncheck();
  await expect(dialog.getByRole("button", { name: "Request 0 parts" })).toBeDisabled();
  await option("Prelims").check();
  await confirm.click();
  await expect(page).toHaveURL(/requests\/request-1$/);
  expect(posts).toEqual([{ kind: "event", identifier: "ufc-1", parts: ["Prelims"] }]);
});

test("the parts dialog is usable on a phone in Spanish and closes without requesting", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("pedirr.locale", "es"));
  await page.setViewportSize({ width: 390, height: 844 });
  const posts = await fixtures(page, { ...admin, locale: "es" });
  await page.goto("/catalog/event/ufc-1");
  await page.getByRole("button", { name: "Pedir este evento" }).click();
  const dialog = page.getByRole("dialog", { name: "Elige las partes" });
  await expect(dialog.getByText("Ya solicitada", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Pedir 2 partes" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/parts-dialog-mobile.png" });
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toEqual([]);
});

test("a request with parts shows each part, the viewer's own status and parts to review", async ({
  page,
}) => {
  await fixtures(page);
  await page.goto("/requests/request-1");
  const parts = page.locator(".request-parts");
  await expect(parts.getByRole("heading", { name: "Parts" })).toBeVisible();
  const row = (name: string) => parts.locator("li").filter({ hasText: name });
  await expect(row("Main Card")).toContainText("Requested by you");
  await expect(row("Main Card")).toContainText("Available");
  await expect(row("Prelims").first()).toContainText("Pending");
  await expect(row("Early Prelims")).toContainText("Not released");
  await expect(page.getByText("Waiting for review: Prelims")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(page.getByText("In the library: Main Card")).toBeVisible();
  await page.screenshot({ path: "test-results/request-parts-desktop.png", fullPage: true });
});
