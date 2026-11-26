import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const admin = {
  id: "admin",
  role: "ADMIN",
  email: "admin@example.invalid",
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
  tenantId: "platform",
  tenant: { code: null, name: "Pedirr" },
  weeklyRequestLimit: null,
  expiresAt: null,
  plan: null,
};
const planId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";
const sports = [
  { id: "sport-combat", name: "Combat" },
  { id: "sport-basketball", name: "Basketball" },
];

type Write = { method: string; path: string; body: Record<string, unknown> };

/** Serves an administrator session with in-memory plans and users, recording every write. */
async function adminApi(page: Page, plans: Record<string, unknown>[] = []) {
  const writes: Write[] = [];
  const user = { ...admin, id: userId, role: "USER", email: "client@example.invalid" };
  await page.route("**/api/v1/**", (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = request.method();
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === "/auth/me") {
      return json(admin);
    }
    if (path === "/auth/csrf") {
      return json({ token: "fixture-token" });
    }
    if (method !== "GET") {
      writes.push({ method, path, body: request.postDataJSON() });
    }
    if (path === "/admin/plans/sports") {
      return json(sports);
    }
    if (path === "/admin/plans" && method === "POST") {
      const body = request.postDataJSON();
      const names: Record<string, string> = {
        "sport-combat": "Combat",
        "league-nba": "NBA",
      };
      const created = {
        id: planId,
        users: 0,
        ...body,
        grants: body.grants.map((grant: { hubId: string }) => ({
          ...grant,
          name: names[grant.hubId],
        })),
      };
      plans.push(created);
      return json(created);
    }
    if (path === "/admin/plans") {
      return json(plans);
    }
    if (path === `/admin/plans/${planId}`) {
      if (method === "PUT") {
        Object.assign(plans[0], request.postDataJSON());
      }
      return json(plans[0]);
    }
    if (path === "/catalog/search") {
      return json({
        query: url.searchParams.get("q"),
        total: 2,
        results: [
          { id: "league-nba", name: "NBA", entityType: "league" },
          { id: "team-1", name: "NBA Team", entityType: "team" },
        ],
      });
    }
    if (path === "/admin/users") {
      return json({ items: [user], total: 1 });
    }
    if (path === "/admin/resellers") {
      return json([]);
    }
    if (path === `/admin/users/${userId}`) {
      if (method === "PATCH") {
        const body = request.postDataJSON();
        Object.assign(user, { plan: plans.find((plan) => plan.id === body.planId) ?? null });
      }
      return json(user);
    }
    return json({});
  });
  return writes;
}

test("administrators create a plan from sports and catalog leagues", async ({ page }) => {
  const writes = await adminApi(page);
  await page.goto("/admin?tab=plans");
  await expect(page.getByText("No plans yet.")).toBeVisible();
  await page.getByRole("link", { name: "Create plan" }).click();
  await page.getByLabel("Name").fill("Fights");
  // A plan is a content package: weekly limits belong to each user.
  await expect(page.getByRole("checkbox", { name: "Weekly request limit" })).toHaveCount(0);
  await expect(
    page.getByRole("radio", { name: "Only the sports and leagues chosen below" }),
  ).toBeChecked();
  await page.getByRole("checkbox", { name: "Combat" }).check();
  await page.getByRole("searchbox", { name: "Search leagues" }).fill("nba");
  const results = page.getByRole("list", { name: "Search results" });
  // Only leagues are offered, not teams.
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await results.getByRole("button", { name: "Add NBA" }).click();
  await expect(
    page.getByRole("list", { name: "Leagues in the plan" }).getByText("NBA"),
  ).toBeVisible();
  await expect(results.getByRole("button", { name: "Remove NBA" })).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
    .analyze();
  expect(scan.violations.map((item) => item.id)).toEqual([]);
  await page.getByRole("button", { name: "Create plan" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/plans/${planId}$`));
  expect(writes[0]).toEqual({
    method: "POST",
    path: "/admin/plans",
    body: {
      name: "Fights",
      allContent: false,
      grants: [
        { kind: "SPORT", hubId: "sport-combat" },
        { kind: "LEAGUE", hubId: "league-nba" },
      ],
    },
  });
  await expect(page.getByRole("heading", { name: "Edit plan" })).toBeVisible();
  await page.getByRole("link", { name: "Plans" }).click();
  await expect(page.getByRole("link", { name: /Fights.*Combat, NBA.*0 users/ })).toBeVisible();
});

test("a plan in use cannot be deleted and can switch to every sport", async ({ page }) => {
  const writes = await adminApi(page, [
    {
      id: planId,
      name: "Fights",
      allContent: false,
      users: 2,
      grants: [{ kind: "SPORT", hubId: "sport-combat", name: "Combat" }],
    },
  ]);
  await page.goto(`/admin/plans/${planId}`);
  await expect(page.getByText("2 users are on this plan.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete plan" })).toHaveCount(0);
  await page.getByRole("radio", { name: "Every sport and league" }).check();
  await expect(page.getByRole("checkbox", { name: "Combat" })).toHaveCount(0);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(writes[0]).toMatchObject({
    method: "PUT",
    body: { allContent: true, grants: [] },
  });
});

test("administrators put a user on a plan", async ({ page }) => {
  const writes = await adminApi(page, [
    {
      id: planId,
      name: "Fights",
      allContent: true,
      users: 0,
      grants: [],
    },
  ]);
  await page.goto("/admin?tab=users");
  await expect(page.getByRole("link", { name: /client@example.invalid.*No plan/ })).toBeVisible();
  await page.goto(`/admin/users/${userId}`);
  const plan = page.getByRole("combobox", { name: "Plan" });
  await expect(plan).toHaveValue("");
  await expect(plan).toHaveAccessibleDescription(/which sports and leagues the user can request/);
  await plan.selectOption({ label: "Fights" });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(writes[0]).toMatchObject({ method: "PATCH", body: { planId } });
});

test("users see when their plan does not include a league", async ({ page }) => {
  const client = {
    ...admin,
    id: userId,
    role: "USER",
    plan: { id: planId, name: "Fights", allContent: false },
  };
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path.endsWith("/auth/me")) {
      body = client;
    } else if (path.endsWith("/catalog/events/nba-1")) {
      body = { id: "nba-1", name: "Lakers vs Celtics" };
    } else if (path.endsWith("/requests/lookup")) {
      body = { state: "not_allowed" };
    } else if (path.endsWith("/requests/parts")) {
      body = { supported: false, parts: [] };
    } else if (path.endsWith("/requests/quota")) {
      body = { limit: null, used: 0, remaining: null, resetsAt: null };
    }
    return route.fulfill({ json: body });
  });
  await page.goto("/catalog/event/nba-1");
  await expect(page.getByRole("status")).toHaveText("Your plan does not include this league.");
  await expect(page.getByRole("button", { name: "Request this event" })).toHaveCount(0);
  await page.goto("/account");
  await expect(page.getByText("Your plan: Fights")).toBeVisible();
  await expect(page.getByText("You can make as many requests as you want.")).toBeVisible();
});

test("users on a plan search its leagues and see why other leagues are closed", async ({
  page,
}) => {
  const client = {
    ...admin,
    id: userId,
    role: "USER",
    plan: { id: planId, name: "Fights", allContent: false },
  };
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/me")) {
      return route.fulfill({ json: client });
    }
    if (path.endsWith("/catalog/search")) {
      return route.fulfill({
        json: {
          query: "u",
          total: 1,
          results: [{ id: "league-ufc", name: "UFC", entityType: "league" }],
        },
      });
    }
    if (path.endsWith("/catalog/leagues/league-nba")) {
      return route.fulfill({ status: 403, json: { code: "PLAN_NOT_ALLOWED" } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/?q=uf");
  await expect(page.getByText("Search covers your plan (Fights): its leagues")).toBeVisible();
  await expect(page.getByRole("heading", { name: "UFC" })).toBeVisible();
  await page.goto("/catalog/league/league-nba");
  await expect(page.getByRole("alert")).toHaveText("Your plan does not include this league.");
});
