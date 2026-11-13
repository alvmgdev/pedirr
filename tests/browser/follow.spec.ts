import { expect, test, type Page } from "@playwright/test";

const viewer = {
  id: "viewer",
  email: "viewer@example.invalid",
  role: "USER",
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
  canRequestSeasons: false,
};
const event = { id: "ufc-334", name: "UFC 334", leagueId: "ufc" };
const base = {
  id: "66666666-6666-4666-8666-666666666666",
  status: "APPROVED",
  version: 1,
  createdAt: "2026-11-10T10:00:00Z",
  integrationState: "synced",
  entity: { title: "UFC 334" },
  scope: { kind: "event", event, league: { id: "ufc", name: "UFC" } },
  _count: { subscribers: 1 },
  parts: [] as { name: string; status: string; rejectionReason: null }[],
  subscription: null as null | { parts: string[]; status: string },
  history: [],
  events: [],
};

async function fixtures(page: Page, request: typeof base, lookup?: object) {
  const posts: unknown[] = [];
  await page.route("**/api/v1/**", (route) => {
    const call = route.request();
    const path = new URL(call.url()).pathname;
    if (path.endsWith("/auth/me")) {
      return route.fulfill({ json: viewer });
    }
    if (path.endsWith("/auth/csrf")) {
      return route.fulfill({ json: { token: "fixture-token" } });
    }
    if (path.endsWith("/requests") && call.method() === "POST") {
      posts.push(call.postDataJSON());
      request.subscription = { parts: [], status: request.status };
      return route.fulfill({ json: { created: false, request } });
    }
    if (path.endsWith(`/requests/${base.id}`)) {
      return route.fulfill({ json: request });
    }
    if (path.endsWith("/requests/parts")) {
      return route.fulfill({
        json: request.parts.length
          ? {
              supported: true,
              parts: [
                { name: "Prelims", optional: false, selected: true, state: "none" },
                { name: "Main Card", optional: false, selected: true, state: "requested" },
              ],
            }
          : { supported: false, parts: [] },
      });
    }
    if (path.endsWith("/requests/lookup")) {
      return route.fulfill({ json: lookup ?? {} });
    }
    if (path.endsWith("/catalog/events/ufc-334")) {
      return route.fulfill({ json: event });
    }
    return route.fulfill({ json: { items: [] } });
  });
  return posts;
}

test("someone else's whole-event request can be followed from its page", async ({ page }) => {
  const posts = await fixtures(page, structuredClone(base));
  await page.goto(`/requests/${base.id}`);
  await page.getByRole("button", { name: "Follow this request" }).click();
  await expect.poll(() => posts).toEqual([{ kind: "event", identifier: "ufc-334" }]);
  await expect(page.getByRole("button", { name: "Follow this request" })).toHaveCount(0);
});

test("someone else's request with parts asks which parts to follow", async ({ page }) => {
  const request = structuredClone(base);
  request.parts = [{ name: "Main Card", status: "APPROVED", rejectionReason: null }];
  const posts = await fixtures(page, request);
  await page.goto(`/requests/${base.id}`);
  await page.getByRole("button", { name: "Request parts" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose parts" });
  await dialog.getByRole("checkbox", { name: "Prelims", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Request 1 part" }).click();
  await expect
    .poll(() => posts)
    .toEqual([{ kind: "event", identifier: "ufc-334", parts: ["Main Card"] }]);
  await expect(dialog).toHaveCount(0);
});

test("the catalog says when the viewer already follows a request", async ({ page }) => {
  await fixtures(page, structuredClone(base), {
    state: "requested",
    request: { id: base.id, status: "APPROVED" },
    subscribed: true,
  });
  await page.goto("/catalog/event/ufc-334");
  await expect(page.getByText("You follow this request.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Follow this request" })).toHaveCount(0);
});
