import { expect, test } from "@playwright/test";

const user = {
  id: "user",
  email: "viewer@example.invalid",
  role: "USER",
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
  canRequestSeasons: false,
};

// The brand mark must span the wordmark's ascender height and sit on its baseline.
for (const [screen, width, signedIn] of [
  ["sign-in", 1280, false],
  ["sign-in on a phone", 390, false],
  ["navigation", 1280, true],
  ["navigation on a phone", 390, true],
] as const) {
  test(`the brand mark lines up with the wordmark on ${screen}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/auth/me")) {
        return route.fulfill(signedIn ? { json: user } : { status: 401, json: {} });
      }
      if (path.endsWith("/auth/config")) {
        return route.fulfill({ json: { registrationEnabled: false } });
      }
      return route.fulfill({ json: { items: [], page: 1, hasMore: false } });
    });
    await page.goto("/");
    const brand = page.locator(".brand").first();
    await expect(brand).toBeVisible();
    const offsets = await brand.evaluate(async (element) => {
      await document.fonts.ready;
      const mark = element.querySelector("svg")!.getBoundingClientRect();
      const word = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)!;
      const range = document.createRange();
      range.selectNodeContents(word);
      const box = range.getBoundingClientRect();
      const style = getComputedStyle(element);
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const metrics = context.measureText("pedirr");
      const baseline = box.top + metrics.fontBoundingBoxAscent;
      return {
        top: mark.top - (baseline - metrics.actualBoundingBoxAscent),
        bottom: mark.bottom - baseline,
      };
    });
    expect(Math.abs(offsets.top), "mark top vs ascender").toBeLessThanOrEqual(1);
    expect(Math.abs(offsets.bottom), "mark bottom vs baseline").toBeLessThanOrEqual(1);
  });
}
