import React from 'react';

// Shared stat tile used by the file-import view and the connector sync
// view so the post-run summary looks the same regardless of how the data
// arrived.
export default function StatPill({ label, value, kind }) {
  const valueColor = kind === 'warn' ? 'var(--warn)'
                   : kind === 'action' ? 'var(--accent-2)'
                   : 'inherit';
  return (
    <div className="panel" style={{ padding: '12px 16px', margin: 0, minWidth: 120 }}>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, color: valueColor }}>{value}</div>
    </div>
  );
}

// Render the standard 9-pill grid for an import_runs totals object,
// shared by file imports and connector syncs. `extras` lets the caller
// inject a leading "rows pulled" pill or similar.
export function StatPillGrid({ totals, extras = null }) {
  const t = totals || {};
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
      {extras}
      <StatPill label="Families created" value={t.families_created || 0} kind="action" />
      <StatPill label="Families attached" value={t.families_attached || 0} />
      <StatPill label="Persons created" value={t.persons_created || 0} kind="action" />
      <StatPill label="Persons attached" value={t.persons_attached || 0} />
      <StatPill
        label="New conflicts"
        value={t.conflicts_opened || 0}
        kind={(t.conflicts_opened || 0) > 0 ? 'warn' : null}
      />
      <StatPill label="Addresses attached" value={t.addresses_attached || 0} />
      <StatPill label="Emails attached" value={t.emails_attached || 0} />
      <StatPill label="Phones attached" value={t.phones_attached || 0} />
      <StatPill label="Memberships opened" value={t.memberships_opened || 0} />
      {(t.rows_skipped_blank || 0) > 0 && (
        <StatPill label="Rows skipped (blank)" value={t.rows_skipped_blank} kind="warn" />
      )}
    </div>
  );
}
