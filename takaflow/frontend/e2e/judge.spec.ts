/**
 * The judge console must work on the day, first click, with nothing set up beforehand.
 *
 * So this test does what a judge does: open the console, sign in with the demo credentials, press
 * "Run everything", and check that every scenario reports a pass.
 */
import { expect, test } from '@playwright/test';

test('every scenario in the judge console passes against the live API', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/judge');

  await page.getByLabel('Username').fill('judge');
  await page.getByLabel('Password').fill('takaflow-demo-2026');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Judge console' })).toBeVisible();

  await page.getByRole('button', { name: 'Run everything' }).click();

  // Eleven scenarios, run sequentially against a real database.
  const summary = page.locator('.badge', { hasText: 'passed' }).first();
  await expect(summary).toContainText('11 passed', { timeout: 150_000 });
  await expect(page.locator('.badge.bad')).toHaveCount(0);
});

test('the console refuses the wrong password', async ({ page }) => {
  await page.goto('/judge');

  await page.getByLabel('Username').fill('judge');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText('Invalid operator credentials')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Judge console' })).toBeHidden();
});
