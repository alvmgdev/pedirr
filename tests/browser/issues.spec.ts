import { expect, test, type Page } from "@playwright/test";

const viewer = {
  id: "viewer",
  email: "viewer@example.invalid",
  role: "USER",
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
  canRequestSeasons: true,
};
const admin = { ...viewer, id: "admin", email: "admin@example.invalid", role: "ADMIN" };
const event = { id: "ufc-334", name: "UFC 334", leagueId: "ufc" };
const request = {
  id: "33333333-3333-4333-8333-333333333333",
  status: "AVAILABLE",
  version: 1,
  createdAt: "2026-11-10T10:00:00Z",
  integrationState: "synced",
  entity: { title: "UFC 334" },
  scope: { kind: "event", event, league: { id: "ufc", name: "UFC" } },
  _count: { subscribers: 1 },
  parts: [{ name: "Main Card", status: "APPROVED", rejectionReason: null }],
  subscription: { parts: ["Main Card"], status: "AVAILABLE" },
  history: [],
  events: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      metadata: event,
      available: true,
      progress: 100,
      parts: ["Prelims", "Main Card"],
      availableParts: ["Main Card"],
      downloadingParts: [],
    },
  ],
};
const issueId = "55555555-5555-4555-8555-555555555555";

function issue(status: string, timeline: unknown[] = [], reporter: object | null = null) {
  return {
    id: issueId,
    status,
    category: "LANGUAGE",
    part: "Main Card",
    description: "The commentary is in Portuguese.",
    createdAt: "2026-11-14T10:00:00Z",
    updatedAt: "2026-11-14T10:00:00Z",
    resolvedAt: null,
    mine: reporter === null,
    reporter,
    request: { id: request.id, title: "UFC 334", kind: "event", season: null },
    event: null,
    comments: timeline.length,
    timeline,
  };
}

async function fixtures(page: Page, user: object, state: { current: ReturnType<typeof issue> }) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  await page.route("**/api/v1/**", (route) => {
    const call = route.request();
    const path = new URL(call.url()).pathname;
    if (path.endsWith("/auth/me")) {
      return route.fulfill({ json: user });
    }
    if (path.endsWith("/auth/csrf")) {
      return route.fulfill({ json: { token: "fixture-token" } });
    }
    if (call.method() !== "GET") {
      writes.push({ method: call.method(), path, body: call.postDataJSON() });
    }
    if (path.endsWith(`/requests/${request.id}/issues`)) {
      return route.fulfill({ json: state.current });
    }
    if (path.endsWith(`/requests/${request.id}`)) {
      return route.fulfill({ json: request });
    }
    if (path.endsWith("/issues/open")) {
      return route.fulfill({ json: { open: 1 } });
    }
    if (path.endsWith(`/issues/${issueId}/comments`)) {
      const body = call.postDataJSON() as { body: string };
      state.current = issue(
        state.current.status,
        [
          ...state.current.timeline,
          {
            id: "c" + state.current.timeline.length,
            body: body.body,
            status: null,
            createdAt: "2026-11-14T11:00:00Z",
            author: { role: "USER", mine: true, email: null },
          },
        ],
        state.current.reporter,
      );
      return route.fulfill({ json: state.current });
    }
    if (path.endsWith(`/issues/${issueId}`)) {
      if (call.method() === "PATCH") {
        const body = call.postDataJSON() as { status: string; comment?: string };
        state.current = issue(
          body.status,
          [
            ...state.current.timeline,
            {
              id: "s" + state.current.timeline.length,
              body: body.comment ?? null,
              status: body.status,
              createdAt: "2026-11-14T12:00:00Z",
              author: { role: "ADMIN", mine: true, email: "admin@example.invalid" },
            },
          ],
          state.current.reporter,
        );
      }
      return route.fulfill({ json: state.current });
    }
    if (path.endsWith("/issues")) {
      return route.fulfill({ json: { items: [state.current], total: 1, page: 1, pageSize: 30 } });
    }
    return route.fulfill({ json: {} });
  });
  return writes;
}

test("a subscriber reports a problem about a part and follows the conversation", async ({
  page,
}) => {
  const state = { current: issue("OPEN") };
  const writes = await fixtures(page, viewer, state);
  await page.goto(`/requests/${request.id}`);
  await page.getByRole("button", { name: "Report a problem" }).click();
  await page.getByRole("combobox", { name: "Problem" }).selectOption("LANGUAGE");
  await page.getByRole("combobox", { name: "Part", exact: true }).selectOption("Main Card");
  await page.getByLabel("What is wrong?").fill("The commentary is in Portuguese.");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${issueId}$`));
  expect(writes[0]).toEqual({
    method: "POST",
    path: `/api/v1/requests/${request.id}/issues`,
    body: {
      category: "LANGUAGE",
      description: "The commentary is in Portuguese.",
      part: "Main Card",
    },
  });
  await expect(
    page.getByRole("heading", { name: "Language, audio track or subtitles" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "UFC 334 / Main Card" })).toBeVisible();
  // Reporters can only close an active issue; review actions belong to administrators.
  await expect(page.getByRole("button", { name: "Close issue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resolve" })).toHaveCount(0);
  await page.getByLabel("Comment", { exact: true }).fill("It is the Main Card only.");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.locator(".issue-timeline")).toContainText("It is the Main Card only.");
  await expect(page.getByRole("link", { name: /Issues/ }).first()).toContainText("1");
});

test("an administrator resolves an issue with an explanation", async ({ page }) => {
  const state = { current: issue("OPEN", [], { id: "viewer", email: "viewer@example.invalid" }) };
  const writes = await fixtures(page, admin, state);
  await page.goto("/issues");
  await expect(page.getByText("viewer@example.invalid", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: /Language, audio track or subtitles/ }).click();
  await expect(page.getByText("Reported by viewer@example.invalid")).toBeVisible();
  await page.getByRole("button", { name: "Mark in progress" }).click();
  await expect(page.locator(".issue-heading .status")).toHaveText("In progress");
  await page.getByRole("button", { name: "Resolve" }).click();
  const note = page.getByLabel("How was it resolved?");
  await expect(note).toHaveAttribute("required", "");
  await note.fill("Replaced the file with the English release.");
  await page.locator(".sidebar-note form").getByRole("button", { name: "Resolve" }).click();
  await expect(page.locator(".issue-heading .status")).toHaveText("Resolved");
  await expect(page.locator(".issue-timeline")).toContainText("Marked as Resolved");
  expect(writes.map((write) => write.body)).toEqual([
    { status: "IN_PROGRESS" },
    { status: "RESOLVED", comment: "Replaced the file with the English release." },
  ]);
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
});

test("issues read well on a phone in Spanish", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pedirr.locale", "es"));
  await page.setViewportSize({ width: 390, height: 844 });
  const state = {
    current: issue("RESOLVED", [
      {
        id: "r1",
        body: "Hemos sustituido el fichero.",
        status: "RESOLVED",
        createdAt: "2026-11-14T12:00:00Z",
        author: { role: "ADMIN", mine: false, email: null },
      },
    ]),
  };
  await fixtures(page, { ...viewer, locale: "es" }, state);
  await page.goto(`/issues/${issueId}`);
  await expect(page.locator(".issue-timeline")).toContainText("Administrador");
  await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/issue-mobile-es.png", fullPage: true });
});
