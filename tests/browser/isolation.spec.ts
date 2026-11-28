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

test("request cards say who asked and when, as far as each viewer may know", async ({ page }) => {
  const card = (requestedBy: unknown) => ({
    id: "r1",
    status: "PENDING",
    version: 0,
    createdAt: "2026-11-10T10:00:00Z",
    integrationState: "idle",
    entity: { title: "UFC 334" },
    scope: { kind: "event", event: { id: "e1", name: "UFC 334" }, league: { id: "l1" } },
    _count: { subscribers: 3 },
    parts: [],
    subscription: null,
    requestedBy,
  });
  const admin = {
    ...base,
    id: "admin",
    email: "admin@example.invalid",
    role: "ADMIN",
    tenantId: "platform",
    tenant: { code: null, name: "Pedirr" },
  };
  let me: Record<string, unknown> = admin;
  let requestedBy: unknown = {
    at: "2026-11-12T10:00:00Z",
    email: "ana@example.invalid",
    environment: tenant,
    others: 2,
  };
  const asked: string[] = [];
  await page.route("**/api/v1/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/k7x2p/api/v1", "").replace("/api/v1", "");
    if (path === "/auth/me") {
      return route.fulfill({ json: me });
    }
    if (path === "/admin/resellers") {
      return route.fulfill({ json: [{ id: "11111111-1111-4111-8111-111111111111", ...tenant }] });
    }
    if (path === "/requests") {
      asked.push(url.searchParams.get("environment") ?? "");
      return route.fulfill({ json: { items: [card(requestedBy)], total: 1, page: 1 } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/requests");
  await expect(
    page.getByText("Requested by ana@example.invalid (Fight Club TV) · Nov 12, 2026"),
  ).toBeVisible();
  await expect(page.getByText("+2 more")).toBeVisible();
  // The platform administrator narrows the list to one environment, kept in the address.
  await page.getByLabel("Environment").selectOption({ label: "Fight Club TV" });
  await expect(page).toHaveURL(/environment=11111111-1111-4111-8111-111111111111/);
  await expect.poll(() => asked.at(-1)).toBe("11111111-1111-4111-8111-111111111111");

  // A reseller's administrator sees its own client, with no environment and no selector.
  me = owner;
  requestedBy = {
    at: "2026-11-13T10:00:00Z",
    email: "ana@example.invalid",
    environment: null,
    others: 0,
  };
  await page.goto("/k7x2p/requests");
  await expect(page.getByText("Requested by ana@example.invalid · Nov 13, 2026")).toBeVisible();
  await expect(page.getByLabel("Environment")).toHaveCount(0);

  // A user only sees the date.
  me = client;
  requestedBy = { at: "2026-11-13T10:00:00Z", email: null, environment: null, others: 0 };
  await page.goto("/k7x2p/requests");
  await expect(page.getByText("Requested on Nov 13, 2026")).toBeVisible();
  await expect(page.getByText(/example\.invalid/)).toHaveCount(0);
});
