import { expect, test } from "@playwright/test";

const tenant = { code: "k7x2p", name: "Fight Club TV" };
const base = {
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
  weeklyRequestLimit: null,
  expiresAt: null,
  plan: null,
  tenantId: "tenant-1",
  tenant,
};
const owner = { ...base, id: "owner", role: "RESELLER", email: "owner@example.invalid" };
const client = {
  ...base,
  id: "client",
  role: "USER",
  email: "ana@example.invalid",
  plan: { id: "plan", name: "Everything", allContent: true },
};
const issueId = "55555555-5555-4555-8555-555555555555";

test("a reseller administrator reads its clients' issues without answering them", async ({
  page,
}) => {
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/k7x2p/api/v1", "");
    if (path === "/auth/me") {
      return route.fulfill({ json: owner });
    }
    if (path === `/issues/${issueId}`) {
      return route.fulfill({
        json: {
          id: issueId,
          status: "OPEN",
          category: "QUALITY",
          part: null,
          description: "The picture is blurry.",
          createdAt: "2026-11-14T10:00:00Z",
          updatedAt: "2026-11-14T10:00:00Z",
          resolvedAt: null,
          mine: false,
          reporter: { id: "client", email: "ana@example.invalid" },
          request: { id: "r1", title: "UFC 334", kind: "event", season: null },
          event: null,
          comments: 1,
          timeline: [
            {
              id: "c1",
              body: "Which part?",
              status: null,
              createdAt: "2026-11-14T11:00:00Z",
              author: { role: "ADMIN", mine: false, email: null },
            },
          ],
        },
      });
    }
    return route.fulfill({ json: { items: [], total: 0, open: 1 } });
  });
  await page.goto(`/k7x2p/issues/${issueId}`);
  await expect(page.getByText("ana@example.invalid").first()).toBeVisible();
  await expect(page.getByText("The picture is blurry.")).toBeVisible();
  // The platform's administrator stays anonymous, and there is nothing to answer or change.
  await expect(page.getByText("Administrator", { exact: true })).toBeVisible();
  await expect(page.getByText("the platform answers and resolves them")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add comment" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close issue" })).toHaveCount(0);
});

test("content another reseller requested shows its state and can be followed", async ({ page }) => {
  let followed = false;
  await page.route("**/api/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/k7x2p/api/v1", "");
    if (path === "/auth/me") {
      return route.fulfill({ json: client });
    }
    if (path === "/auth/csrf") {
      return route.fulfill({ json: { token: "fixture-token" } });
    }
    if (path === "/catalog/events/ufc-1") {
      return route.fulfill({ json: { id: "ufc-1", name: "UFC 334" } });
    }
    if (path === "/requests/lookup") {
      return route.fulfill({
        json: {
          state: "requested",
          request: { id: "r-elsewhere", status: "DOWNLOADING" },
          subscribed: false,
          visible: followed,
        },
      });
    }
    if (path === "/requests/parts") {
      return route.fulfill({ json: { supported: false, parts: [] } });
    }
    if (path === "/requests" && request.method() === "POST") {
      followed = true;
      return route.fulfill({ json: { created: false, request: { id: "r-elsewhere" } } });
    }
    return route.fulfill({ json: { items: [], total: 0, open: 0 } });
  });
  await page.goto("/k7x2p/catalog/event/ufc-1");
  await expect(page.getByText("Downloading", { exact: true })).toBeVisible();
  // Nobody of this reseller follows it yet, so there is no request page to open.
  await expect(page.getByRole("link", { name: "View request" })).toHaveCount(0);
  await page.getByRole("button", { name: "Follow this request" }).click();
  await expect(page).toHaveURL(/\/k7x2p\/requests\/r-elsewhere$/);
});
