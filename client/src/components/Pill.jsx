import React from 'react';

// Posture pill — semantic only. Allowed states:
//   loopback | encrypted | pseudonym | pii | consented | muted
export default function Pill({ state = 'muted', children, className = '', title }) {
  return (
    <span className={`fg-pill ${state} ${className}`} title={title}>
      {children}
    </span>
  );
}
