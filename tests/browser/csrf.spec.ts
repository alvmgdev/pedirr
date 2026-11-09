import { expect, test } from "@playwright/test";

const admin = {
  id: "admin-1",
  email: "admin@example.invalid",
  role: "ADMIN",
  active: true,
  locale: "en",
  timezone: "UTC",
  autoApprove: null,
};
const policy = { registrationEnabled: false, userAutoApprove: false, adminAutoApprove: false };

test("writes reuse one session CSRF token and refresh it once when it goes stale", async ({
  page,
}) => {
  let issued = 0;
  let validToken = "token-1";
  const sentTokens: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/me")) {
      return route.fulfill({ json: admin });
    }
    if (path.endsWith("/auth/csrf")) {
      issued += 1;
      return route.fulfill({ json: { token: `token-${issued}` } });
    }
    if (path.endsWith("/admin/policies") && request.method() === "PATCH") {
      const token = request.headers()["x-csrf-token"];
      sentTokens.push(token);
      if (token !== validToken) {
        return route.fulfill({
          status: 403,
          json: { code: "CSRF_INVALID", message: "Refresh the page and try again" },
        });
      }
      return route.fulfill({ json: request.postDataJSON() });
    }
    return route.fulfill({ json: policy });
  });

  await page.goto("/admin?tab=policies");
  const save = page.getByRole("button", { name: "Save changes" });
  await save.click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  await save.click();
  await expect.poll(() => sentTokens.length).toBe(2);
  expect(issued).toBe(1);

  // Simulate a server-side session change that invalidates the cached token.
  validToken = "token-2";
  await save.click();
  await expect.poll(() => sentTokens.length).toBe(4);
  expect(sentTokens).toEqual(["token-1", "token-1", "token-1", "token-2"]);
  expect(issued).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
