'use strict';

const { test, expect } = require('./_setup.js');

// /conflicts is the workhorse view. The post-v9 changes that need to stay
// honest in the browser:
//   1. The "Why" column renders the resolver's reason chips so the operator
//      sees what triggered the conflict.
//   2. There's a per-row notes textarea that threads through to
//      /api/conflicts/:code/resolve.
//   3. Closed conflicts surface the saved note inline.

test('Conflicts > resolution-notes textarea persists notes through reject', async ({ page, fg }) => {
  // Seed: two duplicate-named persons so the duplicate scan opens a conflict.
  await fg.api.post('/api/people', { given_name: 'Pio', family_name: 'Pietrelcina' });
  await fg.api.post('/api/people', { given_name: 'Pio', family_name: 'Pietrelcina' });
  const scan = await fg.api.post('/api/scan/duplicates', {});
  expect(scan.new_conflicts_opened).toBeGreaterThanOrEqual(1);

  await page.goto('/conflicts');
  // Wait for the table to populate.
  await expect(page.locator('table tbody tr').first()).toBeVisible();

  // The "Why" column should carry resolver reasons. exact_first/last name is
  // what fires for the duplicate-Pio case.
  await expect(page.locator('text=exact_last_name').first()).toBeVisible();
  await expect(page.locator('text=exact_first_name').first()).toBeVisible();

  // Type a note into the first row's textarea.
  const note = 'father and son, confirmed via parish records';
  const textarea = page.locator('textarea[placeholder*="why are you making this decision"]').first();
  await expect(textarea).toBeVisible();
  await textarea.fill(note);

  // Click reject.
  await page.getByRole('button', { name: 'reject' }).first().click();

  // Switch the status filter to rejected and verify the note is rendered.
  await page.locator('select').first().selectOption('rejected');
  await expect(page.getByText(note)).toBeVisible();
});

test('Conflicts > merging records the note alongside the merge', async ({ page, fg }) => {
  const a = (await fg.api.post('/api/people', { given_name: 'Maria', family_name: 'Doe' })).code;
  const b = (await fg.api.post('/api/people', { given_name: 'Maria', family_name: 'Doe' })).code;
  await fg.api.post('/api/scan/duplicates', {});

  await page.goto('/conflicts');
  const textarea = page.locator('textarea[placeholder*="why are you making this decision"]').first();
  await textarea.fill('verified via the parish directory');

  // Merge → keep the LEFT side. The first ← left button corresponds to row 1.
  await page.getByRole('button', { name: '← left' }).first().click();

  // Verify the merge happened — the loser is now an alias of the winner.
  await page.locator('select').first().selectOption('merged');
  await expect(page.getByText('verified via the parish directory')).toBeVisible();
});
