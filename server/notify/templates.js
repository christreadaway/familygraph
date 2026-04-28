'use strict';

// Notification templates. We keep them deliberately small and free of any PII:
// the email tells the colleague "you have N conflicts waiting in Family Graph,
// log in to resolve them by <deadline>". Names of families/people are NEVER
// included — those live behind the Bearer-protected dashboard.

function _hours(ms) {
  return ms / 3_600_000;
}

function _humanRemaining(expiresAtIso, nowMs = Date.now()) {
  const diff = new Date(expiresAtIso).getTime() - nowMs;
  if (diff <= 0) return 'right now (already expired)';
  const h = _hours(diff);
  if (h < 1) return `${Math.max(1, Math.round(diff / 60_000))} minutes`;
  if (h < 24) return `${h.toFixed(h < 4 ? 1 : 0)} hours`;
  const d = h / 24;
  return `${d.toFixed(d < 2 ? 1 : 0)} days`;
}

function _formatDeadline(iso) {
  return new Date(iso).toUTCString();
}

function assignTemplate({ count, expiresAt, dashboardUrl, assignee, ttlHours, institution }) {
  const inst = institution ? `${institution} ` : '';
  const link = `${dashboardUrl.replace(/\/+$/, '')}/conflicts?assigned_to=${encodeURIComponent(assignee)}`;
  const remaining = _humanRemaining(expiresAt);
  const subject = `[Family Graph] ${count} family-data conflict${count === 1 ? '' : 's'} assigned to you (resolve within ${ttlHours}h)`;
  const text = [
    `Hi,`,
    ``,
    `You've been assigned ${count} ${inst}family-data conflict${count === 1 ? '' : 's'} in Family Graph for review.`,
    `Please log in and resolve them within ${ttlHours} hours.`,
    ``,
    `Time remaining: ${remaining}`,
    `Hard deadline: ${_formatDeadline(expiresAt)}`,
    ``,
    `Open your queue: ${link}`,
    ``,
    `If you don't resolve them in time, the assignment will expire and the conflicts will return to the unassigned pool — no action lost, but a colleague will need to pick them up.`,
    ``,
    `— Family Graph`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;line-height:1.5">
    <p>Hi,</p>
    <p>You've been assigned <strong>${count} ${inst}family-data conflict${count === 1 ? '' : 's'}</strong> in Family Graph for review.<br>
       Please log in and resolve them within <strong>${ttlHours} hours</strong>.</p>
    <table style="border-collapse:collapse;background:#f6f7fa;padding:12px;border-radius:8px;margin:16px 0">
      <tr><td style="padding:6px 12px;color:#666">Time remaining</td><td style="padding:6px 12px"><strong>${remaining}</strong></td></tr>
      <tr><td style="padding:6px 12px;color:#666">Hard deadline</td><td style="padding:6px 12px"><strong>${_formatDeadline(expiresAt)}</strong></td></tr>
    </table>
    <p><a href="${link}" style="background:#6f8cff;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Open my queue</a></p>
    <p style="color:#666;font-size:13px">If you don't resolve them in time, the assignment will expire and the conflicts will return to the unassigned pool. No data is lost; another colleague will need to pick them up.</p>
    <p style="color:#888;font-size:12px;margin-top:32px">— Family Graph</p>
  </body></html>`;
  return { subject, text, html };
}

function reminderTemplate({ count, expiresAt, dashboardUrl, assignee, institution }) {
  const inst = institution ? `${institution} ` : '';
  const link = `${dashboardUrl.replace(/\/+$/, '')}/conflicts?assigned_to=${encodeURIComponent(assignee)}`;
  const remaining = _humanRemaining(expiresAt);
  const subject = `[Family Graph] Reminder: ${count} ${inst}conflict${count === 1 ? '' : 's'} assigned to you, ${remaining} left`;
  const text = [
    `Hi,`,
    ``,
    `Just a reminder: you have ${count} ${inst}family-data conflict${count === 1 ? '' : 's'} still open in Family Graph.`,
    ``,
    `Time remaining: ${remaining}`,
    `Hard deadline: ${_formatDeadline(expiresAt)}`,
    ``,
    `Open your queue: ${link}`,
    ``,
    `— Family Graph`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;line-height:1.5">
    <p>Hi,</p>
    <p>Just a reminder: you have <strong>${count} ${inst}family-data conflict${count === 1 ? '' : 's'}</strong> still open in Family Graph.</p>
    <p><strong>Time remaining: ${remaining}</strong> — hard deadline ${_formatDeadline(expiresAt)}.</p>
    <p><a href="${link}" style="background:#f0b551;color:#1c1300;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Open my queue</a></p>
    <p style="color:#888;font-size:12px;margin-top:32px">— Family Graph</p>
  </body></html>`;
  return { subject, text, html };
}

function expiredTemplate({ count, dashboardUrl, assignee, institution }) {
  const inst = institution ? `${institution} ` : '';
  const link = `${dashboardUrl.replace(/\/+$/, '')}/conflicts`;
  const subject = `[Family Graph] Your assignment of ${count} conflict${count === 1 ? '' : 's'} has expired`;
  const text = [
    `Hi,`,
    ``,
    `Your assignment of ${count} ${inst}family-data conflict${count === 1 ? '' : 's'} in Family Graph has expired and the conflict${count === 1 ? ' is' : 's are'} back in the unassigned pool.`,
    ``,
    `If you'd still like to resolve them, log in and reassign or pick them up: ${link}`,
    ``,
    `— Family Graph`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;line-height:1.5">
    <p>Hi,</p>
    <p>Your assignment of <strong>${count} ${inst}family-data conflict${count === 1 ? '' : 's'}</strong> in Family Graph has expired and the conflict${count === 1 ? ' is' : 's are'} back in the unassigned pool.</p>
    <p>If you'd still like to resolve them, log in and reassign or pick them up:<br>
       <a href="${link}">${link}</a></p>
    <p style="color:#888;font-size:12px;margin-top:32px">— Family Graph</p>
  </body></html>`;
  return { subject, text, html };
}

module.exports = { assignTemplate, reminderTemplate, expiredTemplate, _humanRemaining };
