'use strict';

const { test, expect } = require('./_setup.js');

// FamilyDetail.jsx now surfaces:
//   - per-member DOB / age / grade
//   - "do not contact" + "separate residence" pills inline on each member row
//   - employer / title chip when the member's profile is filled in
//   - kid count + adult count next to the panel header
//   - rolled-up Contact Channels panel showing all emails + phones across
//     the family with attribution back to the contributing person

test('FamilyDetail > member rows surface DOB, age, profile flags; channels roll up', async ({ page, fg }) => {
  // Build a family with two adults + one child via the import pipeline so
  // memberships and addresses attach naturally. The CSV uses a school-roster
  // shape recognized by the auto-mapper.
  const csv = [
    'Family Name,Family Address,Family City,Family State,Family Zip,' +
    'Student First Name,Student Last Name,Student DOB,Student Grade,' +
    'Parent 1 First Name,Parent 1 Last Name,Parent 1 Email,Parent 1 Phone,' +
    'Parent 2 First Name,Parent 2 Last Name,Parent 2 Email,Parent 2 Phone',
    'Smith,12 Maple St,Lima,OH,45801,' +
    'Lucy,Smith,2014-05-04,3,' +
    'Mary,Smith,mary@example.org,415-555-0100,' +
    'John,Smith,john@example.org,415-555-0200',
  ].join('\n') + '\n';

  const result = await fg.api.post('/api/import/run', {
    content: csv,
    source: 'facts',
    category: 'school',
  });
  expect(result.totals.persons_created).toBeGreaterThanOrEqual(3);
  expect(result.totals.families_created).toBe(1);

  // Drill into the family — pull the code out of the per-row results.
  const famCode = result.results[0].family.code;
  await page.goto(`/families/${famCode}`);

  // Header carries the kid + adult roll-up.
  await expect(page.getByText(/2 adults · 1 kid/i)).toBeVisible();

  // Lucy's row shows age + grade. memberSubtitle renders "grade N" during
  // the school year and "completed N · rising N+1" during the May 15 –
  // Aug 15 summer gap, so accept either form.
  await expect(page.getByText(/(grade 3|completed 3)/)).toBeVisible();
  await expect(page.locator('text=/age \\d+/').first()).toBeVisible();

  // Contact channels panel rolls up both parents' emails + phones with
  // attribution arrows back to the person codes.
  await expect(page.getByRole('heading', { name: /Contact channels/ })).toBeVisible();
  await expect(page.getByText('mary@example.org')).toBeVisible();
  await expect(page.getByText('john@example.org')).toBeVisible();
});

test('FamilyDetail > "do not contact" flag shows as a pill on the member row', async ({ page, fg }) => {
  // Single-row import then PATCH a do_not_contact flag onto Mary.
  const csv = [
    'first_name,last_name,email,address,city,state,zip',
    'Mary,Smith,mary@example.org,99 Pine Rd,Lima,OH,45801',
  ].join('\n') + '\n';
  const r = await fg.api.post('/api/import/run', { content: csv });
  const famCode = r.results[0].family.code;
  const personCode = r.results[0].persons[0].code;

  await fg.api.patch(`/api/people/${personCode}`, {
    do_not_contact: true,
    do_not_contact_reason: 'unsubscribed',
    not_living_together: true,
    employer: 'Acme Corp',
    title: 'Engineer',
  });

  await page.goto(`/families/${famCode}`);
  await expect(page.getByText('do not contact', { exact: false })).toBeVisible();
  await expect(page.getByText('separate residence')).toBeVisible();
  await expect(page.getByText(/Engineer · Acme Corp/)).toBeVisible();
});

test('FamilyDetail > bulk do-not-call flags every active member', async ({ page, fg }) => {
  // Build a household via the import path so we get adults + child.
  const stamp = Date.now().toString(36);
  const csv = [
    'first_name,last_name,email',
    `Aaa-${stamp},Smith-${stamp},aaa-${stamp}@example.org`,
    `Bbb-${stamp},Smith-${stamp},bbb-${stamp}@example.org`,
  ].join('\n') + '\n';
  const r = await fg.api.post('/api/import/run', { content: csv });
  const famCode = r.results[0].family.code;

  await page.goto(`/families/${famCode}`);
  // The do-not-call panel exists, no flagged members yet.
  await expect(page.getByRole('heading', { name: /Do-not-call list/ })).toBeVisible();

  // Bulk-flag with a reason.
  const reason = 'requested no phone solicitation';
  await page.getByPlaceholder(/Reason/).fill(reason);
  await page.getByRole('button', { name: /Add household to do-not-call list/ }).click();

  // After the flag, every member is marked. The aggregate header reads
  // "applied to N of N members". (Lucy isn't in this CSV; only 2 members.)
  await expect(page.getByText(/applied to \d+ of \d+ member/)).toBeVisible();

  // Confirm via the API: every member now has do_not_contact=true with the reason.
  const fam = await fg.api.get(`/api/families/${famCode}`);
  for (const m of fam.members) {
    expect(m.person.do_not_contact).toBe(true);
    expect(m.person.do_not_contact_reason).toBe(reason);
  }
});

test('Families list > search by last name + quick "Add to do-not-call"', async ({ page, fg }) => {
  const stamp = Date.now().toString(36);
  const r = await fg.api.post('/api/import/run', {
    content: [
      'first_name,last_name,email',
      `Marker-${stamp},Searchable-${stamp},marker-${stamp}@example.org`,
    ].join('\n') + '\n',
  });
  const famCode = r.results[0].family.code;

  await page.goto('/families');
  // The search field narrows the list.
  await page.getByTestId('families-search').fill(`Searchable-${stamp}`);

  // The matching row exposes a "Add to do-not-call" button for the family.
  // Click it; the prompt for reason is dismissed by handling the dialog.
  page.once('dialog', d => d.accept('e2e bulk flag'));
  await page.getByRole('button', { name: /Add to do-not-call/ }).first().click();

  // Re-fetch the family — every member is flagged with the reason.
  // (Polling: the list reload is async; wait for the do-not-call pill.)
  await expect(page.getByText(/do-not-call/i).first()).toBeVisible();
  const fam = await fg.api.get(`/api/families/${famCode}`);
  for (const m of fam.members) {
    expect(m.person.do_not_contact).toBe(true);
    expect(m.person.do_not_contact_reason).toBe('e2e bulk flag');
  }
});
