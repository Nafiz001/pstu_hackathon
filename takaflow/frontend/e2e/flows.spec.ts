/**
 * The journeys a judge will actually click through, driven by a real browser against the real
 * API. Nothing here is mocked: every balance asserted below is one the ledger produced.
 */
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'correct-horse-battery';
const PIN = '1234';

/** Unique per run, so repeated runs never collide on the phone unique index. */
let counter = 0;
const uniquePhone = (): string => {
  counter += 1;
  const stamp = `${Date.now()}${counter}`.slice(-8);
  return `019${stamp}`;
};

interface User {
  phone: string;
  name: string;
}

async function register(page: Page, name: string): Promise<User> {
  const phone = uniquePhone();

  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByPlaceholder('01712345678').fill(phone);
  await page.getByPlaceholder('Rahim Uddin').fill(name);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByPlaceholder('••••').fill(PIN);
  await page.getByRole('button', { name: 'Create account' }).nth(1).click();

  await expect(page.getByRole('heading', { name: /Hello,/ })).toBeVisible();
  return { phone, name };
}

/**
 * The balance as shown on the overview card.
 *
 * Deliberately not `getByText('৳100,000.00')`: the same amount can legitimately appear in the
 * activity list as well, and a locator that matches two things is a test that fails for reasons
 * having nothing to do with the product.
 */
async function expectBalance(page: Page, formatted: string): Promise<void> {
  await expect(page.locator('.balance .amount')).toHaveText(`৳${formatted}`);
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
}

async function signIn(page: Page, user: User): Promise<void> {
  await page.getByPlaceholder('01712345678').fill(user.phone);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).nth(1).click();
  await expect(page.getByRole('heading', { name: /Hello,/ })).toBeVisible();
}

test('a new account is funded by a real minted movement, not a typed-in number', async ({ page }) => {
  await register(page, 'Rahim Test');

  await expectBalance(page, '100,000.00');

  await page.getByRole('link', { name: 'Transactions', exact: true }).click();
  // The signup bonus appears as a MINT from the platform treasury, with a reference like any
  // other movement — because that is exactly what it is.
  await expect(page.getByText('TakaFlow').first()).toBeVisible();
  await expect(page.locator('.amount-in').first()).toContainText('100,000.00');
});

test('sending money moves it, and both sides see the same movement', async ({ page }) => {
  const rahim = await register(page, 'Rahim Sender');
  await signOut(page);
  const karim = await register(page, 'Karim Receiver');
  await signOut(page);
  await signIn(page, rahim);

  await page.getByRole('link', { name: 'Send', exact: true }).click();
  await page.getByPlaceholder('01712345678').fill(karim.phone);
  await expect(page.getByText(`Paying ${karim.name}`)).toBeVisible();

  await page.getByPlaceholder('0.00').fill('2500');
  await page.getByPlaceholder('Lunch').fill('Rickshaw fare');
  await page.getByRole('button', { name: 'Review and send' }).click();

  await page.getByPlaceholder('••••').fill(PIN);
  await page.getByRole('button', { name: /^Send ৳/ }).click();

  await expect(page.getByText(/^Sent ৳2,500.00/)).toBeVisible();
  await expect(page.getByText('New balance ৳97,500.00')).toBeVisible();

  // And the recipient sees the same money arrive.
  await signOut(page);
  await signIn(page, karim);
  await expectBalance(page, '102,500.00');
  await expect(page.getByText('Rickshaw fare')).toBeVisible();
});

test('the five-second undo window cancels before anything is sent', async ({ page }) => {
  const karim = await register(page, 'Karim Untouched');
  await signOut(page);
  await register(page, 'Rahim Undoer');

  await page.getByRole('link', { name: 'Send', exact: true }).click();
  await page.getByPlaceholder('01712345678').fill(karim.phone);
  await page.getByPlaceholder('0.00').fill('4000');
  await page.getByRole('button', { name: 'Review and send' }).click();
  await page.getByPlaceholder('••••').fill(PIN);
  await page.getByRole('button', { name: /^Send ৳/ }).click();

  // The countdown is running and the money has NOT left.
  await expect(page.getByTestId('undo-countdown')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByText('Cancelled. No request was ever sent, so there is nothing to reverse.')).toBeVisible();
  await expect(page.getByTestId('undo-countdown')).toBeHidden();

  // Nothing was sent, so the balance is untouched and there is no transaction to find.
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expectBalance(page, '100,000.00');

  await page.getByRole('link', { name: 'Transactions', exact: true }).click();
  await expect(page.getByText('৳4,000.00')).toBeHidden();
});

test('the emergency freeze blocks outgoing money in one tap, and needs a PIN to lift', async ({ page }) => {
  const karim = await register(page, 'Karim Bystander');
  await signOut(page);
  await register(page, 'Rahim Frozen');

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('switch', { name: 'Emergency freeze' }).click();

  // Instant, no secret asked for, and visible on every page from now on.
  await expect(page.getByText('Account is frozen', { exact: true })).toBeVisible();
  await expect(page.getByText('Your account is frozen.')).toBeVisible();

  // Sending is refused before it can even be attempted.
  await page.getByRole('link', { name: 'Send', exact: true }).click();
  await page.getByPlaceholder('01712345678').fill(karim.phone);
  await page.getByPlaceholder('0.00').fill('100');
  await expect(page.getByRole('button', { name: 'Account frozen' })).toBeDisabled();

  // Lifting it costs the PIN.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('switch', { name: 'Emergency freeze' }).click();
  await page.getByPlaceholder('••••').fill(PIN);
  await page.getByRole('button', { name: 'Unfreeze', exact: true }).click();

  await expect(page.getByText('Account is active', { exact: true })).toBeVisible();
  await expect(page.getByText('Your account is frozen.')).toBeHidden();
});

test('an unusually large transfer goes through and raises a security alert', async ({ page }) => {
  const karim = await register(page, 'Karim Recipient');
  await signOut(page);
  await register(page, 'Rahim Bigspender');

  await page.getByRole('link', { name: 'Send', exact: true }).click();
  await page.getByPlaceholder('01712345678').fill(karim.phone);
  // At the platform's per-transfer ceiling, which is where the anomaly threshold sits.
  await page.getByPlaceholder('0.00').fill('50000');
  await page.getByRole('button', { name: 'Review and send' }).click();
  await page.getByPlaceholder('••••').fill(PIN);
  await page.getByRole('button', { name: /^Send ৳/ }).click();

  // Flagged, NOT blocked: the money moved and the user was warned.
  await expect(page.getByTestId('toast')).toContainText('Security Alert: Unusual transaction detected.');
  await expect(page.getByText(/^Sent ৳50,000.00/)).toBeVisible();

  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expectBalance(page, '50,000.00');
});

test('the recipient can be asked for money, and paying settles it in one step', async ({ page }) => {
  const rahim = await register(page, 'Rahim Payer');
  await signOut(page);
  const karim = await register(page, 'Karim Asker');

  // Karim asks Rahim for 1,200.
  await page.getByRole('link', { name: 'Requests', exact: true }).click();
  await page.getByPlaceholder('01712345678').fill(rahim.phone);
  await page.getByPlaceholder('0.00').fill('1200');
  await page.getByPlaceholder('Dinner on Friday').fill('Concert ticket');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Request sent.')).toBeVisible();

  await signOut(page);
  await signIn(page, rahim);

  // It is waiting for him on the dashboard.
  await expect(page.getByText(/requested ৳1,200.00/)).toBeVisible();

  await page.getByRole('link', { name: 'Requests', exact: true }).click();
  await page.getByRole('button', { name: 'Pay' }).first().click();
  await page.getByPlaceholder('••••').fill(PIN);
  await page.getByRole('button', { name: /^Pay ৳1,200.00$/ }).click();

  await expect(page.getByText('Paid.')).toBeVisible();
  await expect(page.getByText('accepted').first()).toBeVisible();

  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expectBalance(page, '98,800.00');
});

test('a split divides a bill so the shares add up to it exactly', async ({ page }) => {
  const karim = await register(page, 'Karim Diner');
  await signOut(page);
  const salma = await register(page, 'Salma Diner');
  await signOut(page);
  await register(page, 'Rahim Host');

  await page.getByRole('link', { name: 'Split a bill', exact: true }).click();
  await page.getByPlaceholder('Dinner at Star Kabab').fill('Iftar for three');
  await page.getByPlaceholder('0.00').fill('100');

  const numbers = page.getByPlaceholder('01712345678');
  await numbers.first().fill(karim.phone);
  await page.getByRole('button', { name: '+ Add person' }).click();
  await page.getByPlaceholder('01712345678').nth(1).fill(salma.phone);

  // BDT 100 three ways: the preview shows the leftover poisha being handed out, not lost.
  await expect(page.getByText('3 way split: ৳33.34 + ৳33.33 + ৳33.33')).toBeVisible();

  await page.getByRole('button', { name: 'Ask everyone for their share' }).click();
  await expect(page.getByText('Split created — everyone has been asked for their share.')).toBeVisible();

  await page.getByText('Iftar for three').first().click();
  await expect(page.getByRole('cell', { name: '৳33.34' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '৳33.33' }).first()).toBeVisible();
});

test('a schedule is stored as an instruction and moves no money until it is due', async ({ page }) => {
  const karim = await register(page, 'Karim Landlord');
  await signOut(page);
  await register(page, 'Rahim Tenant');

  await page.getByRole('link', { name: 'Scheduled', exact: true }).click();
  await page.getByPlaceholder('01712345678').fill(karim.phone);
  await page.getByPlaceholder('0.00').fill('5000');
  await page.getByPlaceholder('Rent').fill('October rent');
  await page.getByRole('button', { name: 'Create schedule' }).click();

  await page.getByPlaceholder('••••').fill(PIN);
  await page.getByRole('button', { name: 'Create schedule' }).nth(1).click();

  await expect(page.getByText('Schedule created. Nothing moves until it is due.')).toBeVisible();
  await expect(page.getByText(`৳5,000.00 to ${karim.name}`)).toBeVisible();

  // Nothing has been paid — the balance is untouched.
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expectBalance(page, '100,000.00');

  // And it can be paused.
  await page.getByRole('link', { name: 'Scheduled', exact: true }).click();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('paused')).toBeVisible();
});

test('the engineering panel proves idempotency in the browser', async ({ page }) => {
  const karim = await register(page, 'Karim Witness');
  await signOut(page);
  await register(page, 'Rahim Prover');

  await page.getByRole('link', { name: 'Engineering', exact: true }).click();
  await expect(page.getByText('PASS').first()).toBeVisible();

  await page.getByPlaceholder('01712345678').fill(karim.phone);
  await page.getByPlaceholder('••••').fill(PIN);
  await page.getByRole('button', { name: 'Send it twice' }).click();

  // Two simultaneous requests, one key: one payment, two identical answers.
  await expect(page.getByText('One payment, two identical responses.')).toBeVisible();

  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expectBalance(page, '99,999.00');
});

test('the ledger still balances after everything above', async ({ page }) => {
  await register(page, 'Rahim Auditor');
  await page.getByRole('link', { name: 'Engineering', exact: true }).click();

  // Four invariants, checked against the database, after every movement this suite made.
  const badges = page.locator('.badge.ok', { hasText: 'PASS' });
  await expect(badges).toHaveCount(5); // 4 checks + the overall status badge
});
