import { test, expect } from '@playwright/test';

test('season event ordering is delegated to the catalog API and resets pagination', async ({ page }) => {
  const orders: string[] = [];
  await page.route('**/api/v1/**', route => {
    const url = new URL(route.request().url());
    let body: unknown = {};
    if (url.pathname.endsWith('/auth/me')) body = { id: 'user', role: 'USER', email: 'viewer@example.invalid', locale: 'en', timezone: 'UTC' };
    else if (url.pathname.endsWith('/seasons/season-1')) body = { id: 'season-1', name: '2026 season' };
    else if (url.pathname.endsWith('/requests/lookup')) body = { state: 'missing' };
    else if (url.pathname.endsWith('/catalog/events')) {
      orders.push(url.search);
      body = { items: [], page: Number(url.searchParams.get('page')), totalPages: 3 };
    }
    return route.fulfill({ json: body });
  });
  await page.goto('/catalog/season/season-1');
  await expect.poll(() => orders.at(-1)).toContain('order=desc');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => orders.at(-1)).toContain('page=2');
  await page.getByLabel('Event date').selectOption('asc');
  await expect.poll(() => orders.at(-1)).toContain('order=asc');
  expect(orders.at(-1)).toContain('page=1');
});
