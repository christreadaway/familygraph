'use strict';

const { test, expect } = require('./_setup.js');

// PersonDetail.jsx grew a Profile section in the v9 UI work: employer,
// title, do_not_contact (with conditional reason input), and
// not_living_together. The textbox + checkboxes must round-trip through
// PATCH /api/people/:code → GET.

test('PersonDetail > profile fields edit + persist', async ({ page, fg }) => {
  const code = (await fg.api.post('/api/people', {
    given_name: 'Pio', family_name: 'Pietrelcina',
  })).code;

  await page.goto(`/people/${code}`);
  await expect(page.getByRole('heading', { name: /Person/ })).toBeVisible();

  // Profile section should render with employer + title inputs.
  await expect(page.getByText('Profile', { exact: true })).toBeVisible();
  await page.getByPlaceholder('e.g., St. Joseph Hospital').fill('Mercy Health');
  await page.getByPlaceholder('e.g., Director of Development').fill('VP, Development');

  // do_not_contact reveals the reason input when checked.
  const dnc = page.getByRole('checkbox', { name: /Do not contact/ });
  await dnc.check();
  const reason = page.getByPlaceholder(/Reason/);
  await expect(reason).toBeVisible();
  await reason.fill('unsubscribed Q1 2026');

  // not_living_together stays a simple flag.
  await page.getByRole('checkbox', { name: /Not living together/ }).check();

  await page.getByRole('button', { name: 'Save' }).click();

  // Confirm via the API surface (faster + more deterministic than re-reading
  // the form). The new GET should reflect every field we just typed.
  const got = await fg.api.get(`/api/people/${code}`);
  expect(got.person.employer).toBe('Mercy Health');
  expect(got.person.title).toBe('VP, Development');
  expect(got.person.do_not_contact).toBe(true);
  expect(got.person.do_not_contact_reason).toBe('unsubscribed Q1 2026');
  expect(got.person.not_living_together).toBe(true);
});

test('PersonDetail > do_not_contact reason input only appears while checked', async ({ page, fg }) => {
  const code = (await fg.api.post('/api/people', { given_name: 'Mary', family_name: 'Smith' })).code;
  await page.goto(`/people/${code}`);

  // Reason input is not present until DNC is checked.
  await expect(page.getByPlaceholder(/Reason/)).toHaveCount(0);
  await page.getByRole('checkbox', { name: /Do not contact/ }).check();
  await expect(page.getByPlaceholder(/Reason/)).toBeVisible();
  await page.getByRole('checkbox', { name: /Do not contact/ }).uncheck();
  await expect(page.getByPlaceholder(/Reason/)).toHaveCount(0);
});
