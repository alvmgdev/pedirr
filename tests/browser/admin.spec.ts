import { test, expect } from "@playwright/test";
const admin = {
  id: "admin-1",
  email: "admin@example.invalid",
  role: "ADMIN",
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
};
test("administrator tests Sportarr, selects defaults and saves without redisplaying the key", async ({
  page,
}) => {
  let saved = false;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path.endsWith("/auth/me")) body = admin;
    else if (path.endsWith("/auth/csrf")) body = { token: "test-token" };
    else if (path.endsWith("/sportarr/test")) {
      expect(route.request().postDataJSON()).toEqual({
        url: "http://sportarr:8989/sports",
        apiKey: "fixture-key",
      });
      body = {
        version: "4.1.11.0",
        rootFolders: [{ id: 1, path: "/sports" }],
        qualityProfiles: [{ id: 2, name: "HD" }],
      };
    } else if (path.endsWith("/settings/sportarr")) {
      if (route.request().method() === "PUT") {
        expect(route.request().postDataJSON()).toEqual({
          url: "http://sportarr:8989/sports",
          apiKey: "fixture-key",
          rootFolderId: 1,
          qualityProfileId: 2,
        });
        saved = true;
      }
      body = {
        url: saved ? "http://sportarr:8989/sports" : "",
        hasApiKey: saved,
        rootFolderId: saved ? 1 : null,
        qualityProfileId: saved ? 2 : null,
      };
    }
    await route.fulfill({ json: body });
  });
  await page.goto("/admin?tab=sportarr");
  await page.getByLabel("Server URL").fill("http://sportarr:8989/sports");
  await page.getByLabel("API key").fill("fixture-key");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status")).toContainText("Connection successful");
  await page.getByLabel("Library folder").selectOption("1");
  await page.getByLabel("Quality profile").selectOption("2");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveValue("");
  expect(saved).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/admin-mobile.png",
    fullPage: true,
  });
});
test("administrator can set policies and sees protection for the last administrator", async ({
  page,
}) => {
  let policy = {
    registrationEnabled: false,
    userAutoApprove: false,
    adminAutoApprove: false,
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    let status = 200;
    if (path.endsWith("/auth/me")) body = admin;
    else if (path.endsWith("/auth/csrf")) body = { token: "test-token" };
    else if (path.endsWith("/admin/policies")) {
      if (route.request().method() === "PATCH")
        policy = route.request().postDataJSON();
      body = policy;
    } else if (path.endsWith("/admin/users"))
      body = { items: [admin], total: 1 };
    else if (path.endsWith("/admin/users/admin-1")) {
      status = 409;
      body = { code: "LAST_ADMIN" };
    }
    await route.fulfill({ status, json: body });
  });
  await page.goto("/admin?tab=policies");
  await page.getByLabel("Allow registration").check();
  await page.getByLabel("Auto-approve user requests").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText("Changes saved");
  expect(policy).toEqual({
    registrationEnabled: true,
    userAutoApprove: true,
    adminAutoApprove: false,
  });
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page.getByLabel("Active account").uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "At least one active administrator must remain.",
  );
});
test("ordinary users cannot open administration", async ({ page }) => {
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({ json: { ...admin, role: "USER" } }),
  );
  await page.goto("/admin");
  await expect(page.getByRole("alert")).toContainText("You do not have access");
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(
    0,
  );
});

test("notification form preserves saved secrets when fields are left blank", async ({
  page,
}) => {
  const settings = {
    emailEnabled: false,
    smtpHost: "smtp.example.invalid",
    smtpPort: 587,
    smtpSecurity: "starttls",
    smtpUser: "sender",
    emailFrom: "sender@example.invalid",
    discordEnabled: false,
    discordLocale: "en",
    hasSmtpPassword: true,
    hasDiscordWebhook: true,
  };
  let saved = false;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path.endsWith("/auth/me")) body = admin;
    else if (path.endsWith("/auth/csrf")) body = { token: "test-token" };
    else if (path.endsWith("/notifications/deliveries")) body = [];
    else if (path.endsWith("/settings/notifications")) {
      if (route.request().method() === "PUT") {
        const input = route.request().postDataJSON();
        expect(input.smtpPassword).toBeUndefined();
        expect(input.discordWebhook).toBeUndefined();
        expect(input.emailEnabled).toBe(true);
        expect(input.discordEnabled).toBe(true);
        expect(input.smtpPort).toBe(587);
        saved = true;
      }
      body = settings;
    }
    await route.fulfill({ json: body });
  });
  await page.goto("/admin?tab=notifications");
  await page.getByLabel("Enable email notifications").check();
  await page.getByLabel("Enable Discord notifications").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(saved).toBe(true);
});
