import { test, expect } from '@playwright/test';
const user = { id: 'viewer', email: 'viewer@example.invalid', role: 'USER', locale: 'en', timezone: 'UTC' };
const event = { id: 'event-1', name: 'Upcoming final', scheduledStart: '2026-11-07T17:30:00Z' };

test('an empty schedule has no phantom page controls', async ({ page }) => {
  await page.route('**/api/v1/**', route => route.fulfill({ json: route.request().url().endsWith('/auth/me') ? user : { items: [], page: 1, hasMore: false, nextPage: null } }));
  await page.goto('/');
  await expect(page.locator('.empty').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show more events' })).toHaveCount(0);
});

test('schedule loads the next upstream cursor and keeps visible events after a failure', async ({ page }) => {
  const pages: string[] = [];
  await page.route('**/api/v1/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: user });
    if (url.pathname.endsWith('/catalog/upcoming')) {
      pages.push(url.searchParams.get('page')!);
      if (url.searchParams.get('page') === '1') return route.fulfill({ json: { items: [event], page: 3, hasMore: true, nextPage: 4 } });
      return route.fulfill({ status: 502, json: { code: 'METADATA_INVALID' } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: event.name })).toBeVisible();
  await page.getByRole('button', { name: 'Show more events' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: event.name })).toBeVisible();
  expect(pages).toEqual(['1', '4']);
});

test('temporary catalog contention retries automatically after the supplied delay', async ({ page }) => {
  const calls: number[] = [];
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: user });
    if (path.endsWith('/catalog/upcoming')) {
      calls.push(Date.now());
      if (calls.length === 1) return route.fulfill({ status: 503, json: { code: 'METADATA_BUSY', reason: 'local_limit', retryAfterSeconds: 1 } });
      return route.fulfill({ json: { items: [event], page: 1, hasMore: false, nextPage: null } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Pedirr has reached its catalog request limit');
  await expect(page.getByRole('heading', { name: event.name })).toBeVisible();
  expect(calls).toHaveLength(2);
  expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(950);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
