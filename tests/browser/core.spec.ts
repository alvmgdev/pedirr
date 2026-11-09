import { test, expect } from "@playwright/test";
test("login, catalog request and Spanish mobile layout", async ({ page }) => {
  let signedIn = false;
  const user = {
    id: "user",
    email: "viewer@example.invalid",
    role: "USER",
    locale: "en",
    timezone: "Europe/Madrid",
    active: true,
    autoApprove: null,
  };
  const event = {
    id: "event-1",
    name: "Arsenal vs Liverpool",
    leagueName: "Premier League",
    leagueId: "league-1",
    scheduledStart: "2026-11-07T17:30:00Z",
  };
  const request = {
    id: "request-1",
    status: "PENDING",
    version: 0,
    entity: { title: event.name },
    scope: {
      kind: "event",
      event,
      league: { id: "league-1", name: "Premier League" },
    },
    _count: { subscribers: 1 },
    history: [],
    events: [],
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    let status = 200;
    if (path.endsWith("/auth/me")) {
      body = signedIn ? user : {};
      status = signedIn ? 200 : 401;
    } else if (path.endsWith("/auth/csrf")) body = { token: "fixture-token" };
    else if (path.endsWith("/auth/login")) {
      signedIn = true;
      body = user;
    } else if (path.endsWith("/me")) {
      Object.assign(user, route.request().postDataJSON());
      body = user;
    } else if (path.endsWith("/catalog/upcoming"))
      body = { items: [event], page: 1, hasMore: false };
    else if (path.endsWith("/catalog/popular")) body = { items: [] };
    else if (path.endsWith("/catalog/events/event-1")) body = event;
    else if (path.endsWith("/requests/lookup")) body = { state: "missing" };
    else if (path.endsWith("/requests") && route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({
        kind: "event",
        identifier: "event-1",
      });
      body = { created: true, request };
    } else if (path.endsWith("/requests/request-1")) body = request;
    await route.fulfill({ status, json: body });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your sports. Your schedule." })).toBeVisible();
  await page.screenshot({
    path: "test-results/login-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("fixture-long-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Arsenal vs Liverpool" })).toBeVisible();
  await page.screenshot({
    path: "test-results/discover-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("link")
    .filter({
      has: page.getByRole("heading", { name: "Arsenal vs Liverpool" }),
    })
    .click();
  await page.getByRole("button", { name: "Request this event" }).click();
  await expect(page).toHaveURL(/requests\/request-1$/);
  await expect(page.getByText("Pending approval", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Language").selectOption("es");
  await expect(page.getByRole("link", { name: "Descubrir", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Descubrir", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Arsenal vs Liverpool" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: "test-results/discover-mobile.png",
    fullPage: true,
  });
});
test("closed registration is explained in Spanish", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pedirr.locale", "es"));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill(
      path.endsWith("/auth/csrf")
        ? { json: { token: "fixture-token" } }
        : path.endsWith("/auth/register")
          ? { status: 403, json: { code: "REGISTRATION_CLOSED" } }
          : { status: 401, json: {} },
    );
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Crear cuenta", exact: true }).click();
  await page.getByLabel("Correo electrónico").fill("viewer@example.invalid");
  await page.getByLabel("Contraseña", { exact: true }).fill("fixture-long-password");
  await page.getByRole("button", { name: "Crear cuenta", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("El registro está deshabilitado");
});

test("already available catalog content has no request action", async ({ page }) => {
  let writes = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (route.request().method() !== "GET") writes++;
    if (path.endsWith("/auth/me"))
      body = {
        id: "user",
        email: "viewer@example.invalid",
        role: "USER",
        locale: "en",
        timezone: "UTC",
      };
    else if (path.endsWith("/requests/lookup")) body = { state: "available" };
    else if (path.endsWith("/catalog/events/event-1"))
      body = { id: "event-1", name: "Final", leagueId: "league-1", leagueName: "League" };
    await route.fulfill({ json: body });
  });
  await page.goto("/catalog/event/event-1");
  await expect(
    page.getByText("This content is already available in Sportarr. No request is needed."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Request this event" })).toHaveCount(0);
  expect(writes).toBe(0);
});
