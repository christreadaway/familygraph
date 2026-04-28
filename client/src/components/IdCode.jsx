import React from 'react';

// Identifier code. Color-coded per type for muscle memory.
//   family (indigo) · person (cyan) · address (green) · email (yellow) · phone (amber)
// If `type` isn't passed we infer from the prefix.
const PREFIX = {
  f_: 'family',
  p_: 'person',
  addr_: 'address',
  em_: 'email',
  ph_: 'phone',
  conf_: 'family', // conflicts inherit family hue
  imp_: 'family',
  tk_: 'pseudonym',
};

function inferType(code) {
  if (typeof code !== 'string') return '';
  for (const k of Object.keys(PREFIX)) {
    if (code.startsWith(k)) return PREFIX[k];
  }
  return '';
}

export default function IdCode({ type, code, children, className = '', title }) {
  const display = code != null ? code : children;
  const t = type || inferType(display);
  return (
    <span className={`fg-code ${t} ${className}`} title={title}>
      {display}
    </span>
  );
}
