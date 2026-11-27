import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const admin = {
  id: "admin",
  role: "ADMIN",
  email: "admin@example.invalid",
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
  weeklyRequestLimit: null,
  expiresAt: null,
  plan: null,
  tenant: { code: null, name: "Pedirr" },
};
const planId = "22222222-2222-4222-8222-222222222222";
const packageId = "44444444-4444-4444-8444-444444444444";
const resellerId = "55555555-5555-4555-8555-555555555555";
const plans = [{ id: planId, name: "Fights", allContent: true, grants: [], users: 0, packages: 0 }];
type Write = { method: string; path: string; body: Record<string, unknown> };

/** An administrator session with in-memory packages and resellers, recording writes. */
async function platformAdmin(page: Page) {
  const writes: Write[] = [];
  const packages: Record<string, unknown>[] = [];
  const resellers: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
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
    if (path === "/admin/plans") {
      return json(plans);
    }
    if (path === "/admin/packages" && method === "POST") {
      const body = request.postDataJSON();
      const created = {
        id: packageId,
        name: body.name,
        plans: plans.filter((plan) => body.planIds.includes(plan.id)),
        resellers: 0,
      };
      packages.push(created);
      return json(created);
    }
    if (path === "/admin/packages") {
      return json(packages);
    }
    if (path === `/admin/packages/${packageId}`) {
      return json(packages[0]);
    }
    if (path === "/admin/resellers" && method === "POST") {
      const body = request.postDataJSON();
      const created = {
        id: resellerId,
        code: "k7x2p",
        name: body.name,
        active: true,
        maxUsers: body.maxUsers,
        package: { id: packageId, name: "Starter" },
        admin: { id: "owner", email: body.admin.email },
        clients: 0,
      };
      resellers.push(created);
      return json(created);
    }
    if (path === "/admin/resellers") {
      return json(resellers);
    }
    if (path === `/admin/resellers/${resellerId}`) {
      if (method === "PATCH") {
        Object.assign(resellers[0], request.postDataJSON());
      }
      return json(resellers[0]);
    }
    if (path === `/admin/resellers/${resellerId}/admin-password`) {
      return json({ ok: true });
    }
    return json({});
  });
  return { writes, packages };
}

test("the platform administrator creates a package and a reseller to hand out", async ({
  page,
}) => {
  const { writes } = await platformAdmin(page);
  await page.goto("/admin?tab=packages");
  await expect(page.getByText("No packages yet.")).toBeVisible();
  await page.getByRole("link", { name: "Create package" }).click();
  await page.getByLabel("Name").fill("Starter");
  await page.getByRole("checkbox", { name: "Fights" }).check();
  await page.getByRole("button", { name: "Create package" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/packages/${packageId}$`));
  expect(writes[0]).toEqual({
    method: "POST",
    path: "/admin/packages",
    body: { name: "Starter", planIds: [planId] },
  });

  await page.goto("/admin?tab=resellers");
  await expect(page.getByText("No resellers yet.")).toBeVisible();
  await page.getByRole("link", { name: "Create reseller" }).click();
  await page.getByLabel("Name").fill("Fight Club TV");
  await expect(page.getByLabel("Address code")).toHaveAccessibleDescription(/generate one/);
  await page.getByLabel("Package").selectOption({ label: "Starter" });
  await page.getByRole("checkbox", { name: "Client limit" }).check();
  await page.getByLabel("Clients", { exact: true }).fill("25");
  await page.getByLabel("Email").fill("owner@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("a-long-enough-password");
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
    .analyze();
  expect(scan.violations.map((item) => item.id)).toEqual([]);
  await page.getByRole("button", { name: "Create reseller" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/resellers/${resellerId}$`));
  // Without a code, the server generates one; none is sent.
  expect(writes[1]).toEqual({
    method: "POST",
    path: "/admin/resellers",
    body: {
      name: "Fight Club TV",
      packageId,
      maxUsers: 25,
      admin: { email: "owner@example.invalid", password: "a-long-enough-password" },
    },
  });
  // The address to hand out.
  await expect(page.locator(".address-row code")).toHaveText(/\/k7x2p\/$/);
});

test("a reseller can be disabled and its administrator given a new password", async ({ page }) => {
  const { writes } = await platformAdmin(page);
  await page.goto("/admin/resellers/new");
  await page.getByLabel("Name").fill("Fight Club TV");
  await page.getByLabel("Email").fill("owner@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("a-long-enough-password");
  await page.getByRole("button", { name: "Create reseller" }).click();
  await expect(page.getByRole("heading", { name: "Fight Club TV" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Active" })).toHaveAccessibleDescription(
    /signed out and cannot sign in/,
  );
  await page.getByRole("checkbox", { name: "Active" }).uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(writes.at(-1)).toMatchObject({ method: "PATCH", body: { active: false, maxUsers: null } });
  await page.getByLabel("New password").fill("another-long-password");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password changed.")).toBeVisible();
  expect(writes.at(-1)).toEqual({
    method: "POST",
    path: `/admin/resellers/${resellerId}/admin-password`,
    body: { password: "another-long-password" },
  });
  await page.getByRole("link", { name: "Resellers" }).first().click();
  await expect(page.getByRole("row", { name: /Fight Club TV.*\/k7x2p\/.*Disabled/ })).toBeVisible();
});

test("the platform administrator sees every account with its environment", async ({ page }) => {
  const clientId = "66666666-6666-4666-8666-666666666666";
  const reseller = {
    id: resellerId,
    code: "k7x2p",
    name: "Fight Club TV",
    active: true,
    maxUsers: null,
    package: { id: packageId, name: "Starter" },
    admin: { id: "owner", email: "owner@example.invalid" },
    clients: 1,
  };
  const platformUser = {
    ...admin,
    id: "platform-user",
    role: "USER",
    email: "fan@example.invalid",
  };
  const resellerClient = {
    ...admin,
    id: clientId,
    role: "USER",
    email: "client@example.invalid",
    tenantId: resellerId,
    tenant: { code: "k7x2p", name: "Fight Club TV" },
  };
  const listed: string[] = [];
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", "");
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === "/auth/me") {
      return json(admin);
    }
    if (path === "/auth/csrf") {
      return json({ token: "fixture-token" });
    }
    if (path === "/admin/resellers") {
      return json([reseller]);
    }
    if (path === `/admin/packages/${packageId}`) {
      return json({
        id: packageId,
        name: "Starter",
        plans: [{ id: planId, name: "Fights" }],
        resellers: 1,
      });
    }
    if (path === "/admin/plans") {
      return json([...plans, { ...plans[0], id: "other", name: "Other" }]);
    }
    if (path === "/admin/users") {
      listed.push(url.searchParams.get("tenant") ?? "");
      const tenant = url.searchParams.get("tenant");
      const items = [platformUser, resellerClient].filter(
        (user) => !tenant || user.tenantId === tenant,
      );
      return json({ items, total: items.length });
    }
    if (path === `/admin/users/${clientId}`) {
      if (request.method() === "PATCH") {
        writes.push(request.postDataJSON());
      }
      return json(resellerClient);
    }
    return json({});
  });
  await page.goto("/admin?tab=users");
  await expect(page.getByRole("row", { name: /fan@example.invalid.*Platform/ })).toBeVisible();
  await expect(
    page.getByRole("row", { name: /client@example.invalid.*Fight Club TV/ }),
  ).toBeVisible();
  await page.getByLabel("Environment").selectOption({ label: "Fight Club TV" });
  await expect(page.getByRole("link", { name: /fan@example.invalid/ })).toHaveCount(0);
  expect(listed.at(-1)).toBe(resellerId);

  await page.getByRole("link", { name: /client@example.invalid/ }).click();
  // A reseller's client keeps its role and only gets plans of the reseller's package.
  await expect(page.getByRole("combobox", { name: "Role" })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/admin/users/${clientId}$`));
  await expect(page.locator(".account-facts")).toContainText("Fight Club TV");
  const plan = page.getByRole("combobox", { name: "Plan" });
  await expect(plan).toHaveAccessibleDescription("Plans of the reseller's package (Starter).");
  await expect(plan.locator("option")).toHaveText(["No plan: cannot request anything", "Fights"]);
  await plan.selectOption({ label: "Fights" });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(writes[0]).toMatchObject({ planId });
  expect(writes[0]).not.toHaveProperty("role");
});
