import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const locale of ["en", "es"]) {
  test(`main screens are accessible in ${locale}`, async ({ page }) => {
    test.setTimeout(120000);
    const user = {
      id: "admin-1",
      email: "admin@example.invalid",
      role: "ADMIN",
      active: true,
      locale,
      timezone: "Europe/Madrid",
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
      scope: { kind: "event", event },
      _count: { subscribers: 2 },
      parts: [
        { name: "Main Card", status: "APPROVED", rejectionReason: null },
        { name: "Prelims", status: "PENDING", rejectionReason: null },
      ],
      subscription: { parts: ["Main Card"], status: "AVAILABLE" },
      history: [],
      events: [
        {
          id: "request-event-1",
          metadata: event,
          available: true,
          progress: 100,
          parts: ["Prelims", "Main Card"],
          availableParts: ["Main Card"],
          downloadingParts: [],
        },
      ],
    };
    const issue = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "IN_PROGRESS",
      category: "LANGUAGE",
      part: "Main Card",
      description: "The commentary is in another language.",
      createdAt: "2026-11-08T10:00:00Z",
      updatedAt: "2026-11-08T12:00:00Z",
      resolvedAt: null,
      mine: false,
      reporter: { id: "user-1", email: "viewer@example.invalid" },
      request: { id: "request-1", title: event.name, kind: "event", season: null },
      event: null,
      comments: 1,
    };
    let signedIn = false;
    await page.addInitScript((value) => localStorage.setItem("pedirr.locale", value), locale);
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown;
      if (path.endsWith("/auth/me")) {
        await route.fulfill({ status: signedIn ? 200 : 401, json: signedIn ? user : {} });
        return;
      }
      if (path.endsWith("/auth/config")) {
        body = { registrationEnabled: false };
      } else if (path.endsWith("/catalog/upcoming")) {
        body = { items: [event], page: 1, hasMore: false };
      } else if (path.endsWith("/catalog/popular")) {
        body = { items: [] };
      } else if (path.endsWith("/catalog/events/event-1")) {
        body = event;
      } else if (path.endsWith("/requests/lookup")) {
        body = { state: "missing" };
      } else if (path.endsWith("/requests/parts")) {
        body = {
          supported: true,
          parts: [
            { name: "Early Prelims", optional: false, selected: true, state: "none" },
            { name: "Prelims", optional: false, selected: true, state: "requested" },
            { name: "Main Card", optional: false, selected: true, state: "available" },
            { name: "Post Show", optional: true, selected: false, state: "none" },
          ],
        };
      } else if (path.endsWith("/issues/open")) {
        body = { open: 1 };
      } else if (path.endsWith(`/issues/${issue.id}`)) {
        body = {
          ...issue,
          timeline: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              body: "Checking the release.",
              status: "IN_PROGRESS",
              createdAt: "2026-11-08T12:00:00Z",
              author: { role: "ADMIN", mine: true, email: user.email },
            },
          ],
        };
      } else if (path.endsWith("/issues")) {
        body = { items: [issue], total: 1, page: 1, pageSize: 30 };
      } else if (path.endsWith("/requests/request-1")) {
        body = request;
      } else if (path.endsWith("/requests")) {
        body = { items: [request], total: 1, page: 1, pageSize: 30 };
      } else if (path.endsWith("/admin/users")) {
        body = { items: [user], total: 1, page: 1, pageSize: 50 };
      } else if (path.endsWith("/admin/users/admin-1")) {
        body = user;
      } else if (path.endsWith("/admin/policies")) {
        body = { registrationEnabled: false, userAutoApprove: false, adminAutoApprove: false };
      } else if (path.endsWith("/settings/sportarr")) {
        body = {
          configured: false,
          url: "",
          hasApiKey: false,
          rootFolderId: null,
          qualityProfileId: null,
        };
      } else if (path.endsWith("/settings/notifications/deliveries")) {
        body = [];
      } else if (path.endsWith("/settings/notifications")) {
        body = {
          emailEnabled: false,
          smtpHost: "",
          smtpPort: 587,
          smtpSecurity: "starttls",
          smtpUser: "",
          emailFrom: "",
          discordEnabled: false,
          discordLocale: locale,
          hasSmtpPassword: false,
          hasDiscordWebhook: false,
        };
      } else {
        throw new Error(`Unexpected accessibility fixture route: ${path}`);
      }
      await route.fulfill({ json: body });
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    async function inspect(path: string) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      expect(errors, path).toEqual([]);
      await expect(page.locator("html"), path).toHaveAttribute("lang", locale);
      await expect(page.getByRole("heading", { level: 1 }), path).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
        .analyze();
      expect(
        results.violations.map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
        })),
        path,
      ).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        path,
      ).toBe(true);
    }
    await inspect("/");
    signedIn = true;
    if (locale === "es") {
      await page.setViewportSize({ width: 390, height: 844 });
    }
    for (const path of [
      "/",
      "/catalog/event/event-1",
      "/requests",
      "/requests/request-1",
      "/issues",
      `/issues/${issue.id}`,
      "/account",
      "/admin",
      "/admin/users/admin-1",
      "/admin/users/new",
      "/admin?tab=policies",
      "/admin?tab=sportarr",
      "/admin?tab=notifications",
    ]) {
      await inspect(path);
    }
    // The parts dialog is modal: checked on its own, then dismissed with Escape.
    await page.goto("/catalog/event/event-1");
    await page.locator(".request-box > button").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const dialogResults = await new AxeBuilder({ page })
      .include(".parts-dialog")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
      .analyze();
    expect(dialogResults.violations.map((item) => item.id)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.goto("/");
    await expect(page.locator("#main")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.locator(".skip-link")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
    expect(errors).toEqual([]);
  });
}
