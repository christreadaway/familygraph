import React from 'react';

// Provenance dot — fixed colors, distinct from posture palette.
// Maps source strings to known classes; falls back to 'other'.
const MAP = {
  facts: 'facts',
  FACTS: 'facts',
  renweb: 'renweb',
  RenWeb: 'renweb',
  ministry_platform: 'mp',
  'Ministry Platform': 'mp',
  mp: 'mp',
  sheets: 'sheets',
  'Google Sheets': 'sheets',
  csv: 'csv',
  CSV: 'csv',
  excel: 'excel',
  Excel: 'excel',
  xlsx: 'excel',
};

export default function ProvDot({ source, className = '', title }) {
  const cls = MAP[source] || 'other';
  return (
    <span className={`fg-prov ${cls} ${className}`} title={title || source} />
  );
}
