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

test('the shared wallet preview is interactive and clearly labelled as unbuilt', async ({ page }) => {
  await page.goto('/judge');
  await page.getByLabel('Username').fill('judge');
  await page.getByLabel('Password').fill('takaflow-demo-2026');
  await page.getByRole('button', { name: 'Sign in' }).click();

  const preview = page.locator('.card.preview');
  await expect(preview).toContainText('design preview · not built');
  await expect(preview).toContainText('1/5 approved');

  // The claim that matters: this mockup talks to nothing. Anything it sent would make it look
  // like the other scenarios, which report what a server actually did.
  const apiCalls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1')) apiCalls.push(request.url());
  });

  // Approving as the four remaining members drives it to unanimity.
  for (const name of ['Karim', 'Salma', 'Nabil', 'Tania']) {
    await preview.getByRole('button', { name: `Approve as ${name}` }).click();
  }

  await expect(preview).toContainText('5/5 approved');
  await expect(preview).toContainText('EXECUTED');
  expect(apiCalls, `the preview must not call the API, but it called ${apiCalls.join(', ')}`).toEqual([]);

  await preview.getByRole('button', { name: 'Reset' }).click();
  await expect(preview).toContainText('1/5 approved');
  await expect(preview).toContainText('PENDING');
});
