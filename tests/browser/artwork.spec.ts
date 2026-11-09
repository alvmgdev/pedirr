import { test, expect } from "@playwright/test";

test("catalog artwork uses borderless logos and a neutral missing-image icon", async ({ page }) => {
  const items = [
    {
      id: "league-1",
      entityType: "league",
      name: "Premier League",
      sportName: "Soccer",
      logoUrl: "https://artwork.invalid/logo.svg",
    },
    {
      id: "event-1",
      entityType: "event",
      name: "Arsenal vs Liverpool",
      leagueName: "Premier League",
      scheduledStart: "2026-11-07T17:30:00Z",
      thumbUrl: "https://artwork.invalid/photo.svg",
    },
    {
      id: "league-2",
      entityType: "league",
      name: "National Basketball Association",
      logoUrl: "https://artwork.invalid/missing.png",
    },
    { id: "team-1", entityType: "team", name: "Athletic Club", logoUrl: "javascript:invalid" },
  ];
  await page.route("https://artwork.invalid/**", (route) => {
    if (route.request().url().endsWith("missing.png")) {
      return route.fulfill({ status: 404 });
    }
    const logo = route.request().url().endsWith("logo.svg");
    return route.fulfill({
      contentType: "image/svg+xml",
      body: logo
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="white"/><circle cx="60" cy="60" r="36" fill="#163dd5"/><text x="60" y="70" text-anchor="middle" font-family="sans-serif" font-size="28" fill="white">PL</text></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#142a52"/><path d="M0 120L160 50L320 120V180H0" fill="#35866f"/><path d="M50 140L160 90L270 140L160 170Z" fill="none" stroke="white" stroke-width="3"/></svg>',
    });
  });
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json: path.endsWith("/auth/me")
        ? {
            id: "viewer",
            email: "viewer@example.invalid",
            role: "USER",
            locale: "en",
            timezone: "UTC",
          }
        : path.endsWith("/catalog/search")
          ? { results: items }
          : { items: [] },
    });
  });
  await page.goto("/?q=sport");
  await expect(page.getByRole("heading", { name: "Premier League", exact: true })).toBeVisible();
  const logo = page.locator(".fixture-league").first().locator(".artwork");
  await expect(logo.locator("img")).toHaveCSS("object-fit", "contain");
  await expect(logo).toHaveCSS("background-color", "rgb(168, 180, 196)");
  await expect(logo).toHaveCSS("border-width", "0px");
  await expect(logo.locator("img")).toHaveCSS("padding", "0px");
  await expect(page.locator(".fixture-event img")).toHaveCSS("object-fit", "cover");
  await expect(
    page.locator(".fixture-league").last().locator(".artwork-default img"),
  ).toHaveAttribute("src", "/images/artwork-default.svg");
  await expect(page.locator(".fixture-team .artwork-default img")).toHaveAttribute(
    "src",
    "/images/artwork-default.svg",
  );
  await expect(logo.locator("img")).toHaveCSS("background-color", "rgb(168, 180, 196)");
  await expect(page.locator(".artwork-default img").first()).toHaveJSProperty("naturalWidth", 96);
  await page.screenshot({ path: "test-results/artwork-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Arsenal vs Liverpool" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/artwork-mobile.png", fullPage: true });
  const filters = page.getByRole("navigation", { name: "Filter returned results" });
  await filters.getByRole("button", { name: "Teams", exact: true }).click();
  await expect(page.locator(".fixture")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Athletic Club" })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveValue("sport");
  await filters.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.locator(".fixture")).toHaveCount(4);
});

test("request status tabs preserve personal filtering and reset pagination", async ({ page }) => {
  const queries: string[] = [];
  await page.route("**/api/v1/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/requests")) {
      queries.push(url.search);
    }
    return route.fulfill({
      json: url.pathname.endsWith("/auth/me")
        ? {
            id: "viewer",
            email: "viewer@example.invalid",
            role: "USER",
            locale: "en",
            timezone: "UTC",
          }
        : { items: [], total: 0 },
    });
  });
  await page.goto("/requests?mine=true&page=3");
  const filters = page.getByRole("navigation", { name: "Status", exact: true });
  await filters.getByRole("button", { name: "Available", exact: true }).click();
  await expect(filters.getByRole("button", { name: "Available", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => queries.at(-1)).toContain("status=AVAILABLE");
  expect(new URL(page.url()).searchParams.get("mine")).toBe("true");
  expect(new URL(page.url()).searchParams.get("page")).toBe("1");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/request-tabs-mobile.png", fullPage: true });
});
