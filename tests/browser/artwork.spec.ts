import { test, expect } from '@playwright/test';

test('catalog artwork frames white logos and falls back after image failures', async ({ page }) => {
  const items = [
    { id: 'league-1', entityType: 'league', name: 'Premier League', sportName: 'Soccer', logoUrl: 'https://artwork.invalid/logo.svg' },
    { id: 'event-1', entityType: 'event', name: 'Arsenal vs Liverpool', leagueName: 'Premier League', scheduledStart: '2026-11-07T17:30:00Z', thumbUrl: 'https://artwork.invalid/photo.svg' },
    { id: 'league-2', entityType: 'league', name: 'National Basketball Association', logoUrl: 'https://artwork.invalid/missing.png' },
    { id: 'team-1', entityType: 'team', name: 'Athletic Club', logoUrl: 'javascript:invalid' },
  ];
  await page.route('https://artwork.invalid/**', route => {
    if (route.request().url().endsWith('missing.png')) return route.fulfill({ status: 404 });
    const logo = route.request().url().endsWith('logo.svg');
    return route.fulfill({ contentType: 'image/svg+xml', body: logo
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="white"/><circle cx="60" cy="60" r="36" fill="#163dd5"/><text x="60" y="70" text-anchor="middle" font-family="sans-serif" font-size="28" fill="white">PL</text></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#142a52"/><path d="M0 120L160 50L320 120V180H0" fill="#35866f"/><path d="M50 140L160 90L270 140L160 170Z" fill="none" stroke="white" stroke-width="3"/></svg>' });
  });
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith('/auth/me') ? { id: 'viewer', email: 'viewer@example.invalid', role: 'USER', locale: 'en', timezone: 'UTC' }
      : path.endsWith('/catalog/search') ? { results: items } : { items: [] } });
  });
  await page.goto('/?q=sport');
  await expect(page.getByRole('heading', { name: 'Premier League', exact: true })).toBeVisible();
  const logo = page.locator('.fixture-league').first().locator('.artwork');
  await expect(logo.locator('img')).toHaveCSS('object-fit', 'contain');
  await expect(logo).toHaveCSS('background-color', 'rgb(233, 238, 245)');
  await expect(page.locator('.fixture-event img')).toHaveCSS('object-fit', 'cover');
  await expect(page.locator('.fixture-league').last().locator('.artwork-initials')).toHaveText('NB');
  await expect(page.locator('.fixture-team .artwork-initials')).toHaveText('AC');
  await page.screenshot({ path: 'test-results/artwork-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Arsenal vs Liverpool' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/artwork-mobile.png', fullPage: true });
});
