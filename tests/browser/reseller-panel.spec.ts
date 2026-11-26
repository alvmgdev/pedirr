import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const tenant = { code: "k7x2p", name: "Fight Club TV" };
const owner = {
  id: "owner",
  role: "RESELLER",
  email: "owner@example.invalid",
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
const planId = "22222222-2222-4222-8222-222222222222";
const clientId = "77777777-7777-4777-8777-777777777777";

/** A reseller administrator's session; records writes. */
async function resellerAdmin(page: Page, maxUsers: number | null = null) {
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const clients: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/k7x2p/api/v1", "");
    const method = request.method();
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === "/auth/me") {
      return json(owner);
    }
    if (path === "/auth/csrf") {
      return json({ token: "fixture-token" });
    }
    if (method !== "GET") {
      writes.push({ method, path, body: request.postDataJSON() });
    }
    if (path === "/reseller/overview") {
      return json({
        ...tenant,
        maxUsers,
        package: { id: "pack", name: "Starter", plans: [{ id: planId, name: "Fights" }] },
        clients: clients.length,
      });
    }
    if (path === "/reseller/clients" && method === "POST") {
      const body = request.postDataJSON();
      const created = {
        ...owner,
        id: clientId,
        role: "USER",
        email: body.email,
        plan: body.planId ? { id: planId, name: "Fights", allContent: true } : null,
        weeklyRequestLimit: body.weeklyRequestLimit,
      };
      clients.push(created);
      return json(created);
    }
    if (path === "/reseller/clients") {
      return json({ items: clients, total: clients.length });
    }
    if (path === `/reseller/clients/${clientId}`) {
      if (method === "PATCH") {
        Object.assign(clients[0], request.postDataJSON());
      }
      return json(clients[0]);
    }
    if (path === `/reseller/clients/${clientId}/password`) {
      return json({ ok: true });
    }
    return json({ items: [], total: 0, open: 0 });
  });
  return writes;
}

test("a reseller administrator creates a client with a plan of its package", async ({ page }) => {
  const writes = await resellerAdmin(page);
  await page.goto("/k7x2p/admin");
  await expect(page.getByRole("heading", { name: "Fight Club TV", level: 1 })).toBeVisible();
  await expect(page.locator(".address-row code")).toHaveText(/\/k7x2p\/$/);
  await expect(page.getByText("Starter", { exact: true })).toBeVisible();
  await expect(page.getByText("No clients yet.")).toBeVisible();
  await page.getByRole("link", { name: "Create client" }).click();
  await expect(page).toHaveURL(/\/k7x2p\/admin\/clients\/new$/);
  await page.getByLabel("Email").fill("fan@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("a-long-enough-password");
  const plan = page.getByRole("combobox", { name: "Plan" });
  await expect(plan.locator("option")).toHaveText(["No plan: cannot request anything", "Fights"]);
  await plan.selectOption({ label: "Fights" });
  await page.getByRole("checkbox", { name: "Weekly request limit" }).check();
  await page.getByLabel("Requests per week").fill("3");
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
    .analyze();
  expect(scan.violations.map((item) => item.id)).toEqual([]);
  await page.getByRole("button", { name: "Create client" }).click();
  await expect(page).toHaveURL(new RegExp(`/k7x2p/admin/clients/${clientId}$`));
  expect(writes[0]).toEqual({
    method: "POST",
    path: "/reseller/clients",
    body: {
      email: "fan@example.invalid",
      password: "a-long-enough-password",
      planId,
      weeklyRequestLimit: 3,
      expiresAt: null,
    },
  });

  // Deactivating and a new password; the role and approval are never sent.
  await page.getByRole("checkbox", { name: "Active account" }).uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(writes[1].body).toMatchObject({ active: false, planId });
  expect(writes[1].body).not.toHaveProperty("role");
  expect(writes[1].body).not.toHaveProperty("autoApprove");
  await page.getByLabel("New password").fill("another-long-password");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password changed.")).toBeVisible();
  await page.getByRole("link", { name: "Clients" }).click();
  await expect(
    page.getByRole("link", { name: /fan@example.invalid.*Fights.*Inactive/ }),
  ).toBeVisible();
});

test("a reseller at its client limit cannot create more", async ({ page }) => {
  await resellerAdmin(page, 0);
  await page.goto("/k7x2p/admin");
  await expect(
    page.getByText("You have reached the number of clients you can have."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Create client" })).toHaveCount(0);
});
