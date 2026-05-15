'use strict';

// Security requirement: every `npm install` for this project must run
// through Socket Firewall (`sfw`). The wrapper inspects each fetched
// package against Socket's risk database and refuses known-malicious
// installs at the network layer, which closes the supply-chain hole that
// `npm install` alone leaves open.
//
// This guard runs as the `preinstall` script. It accepts any of:
//   SFW=1                          operator-set marker (recommended)
//   SOCKET_FIREWALL=1              set by `sfw` in some versions
//   npm_config_user_agent contains "socket"   set when sfw proxies npm
//
// Emergency-only bypass:           SFW_BYPASS=1
// Any bypass must be logged in session_notes.md per CLAUDE.md conventions.

const ua = (process.env.npm_config_user_agent || '').toLowerCase();

if (
  process.env.SFW === '1' ||
  process.env.SOCKET_FIREWALL === '1' ||
  ua.includes('socket')
) {
  process.exit(0);
}

if (process.env.SFW_BYPASS === '1') {
  process.stderr.write(
    '[security] SFW_BYPASS=1 set; Socket Firewall guard skipped. ' +
      'Record this bypass in session_notes.md.\n'
  );
  process.exit(0);
}

process.stderr.write(
  '\n' +
    '  npm install refused: Socket Firewall (sfw) not detected.\n' +
    '\n' +
    '  This project requires dependency installs to route through Socket\n' +
    '  Firewall so malicious packages are blocked before they touch disk.\n' +
    '  Running plain `npm install` bypasses that defense and is not\n' +
    '  allowed here.\n' +
    '\n' +
    '  Install sfw once:\n' +
    '    npm install -g sfw\n' +
    '\n' +
    '  Then install dependencies:\n' +
    '    SFW=1 sfw npm install\n' +
    '    SFW=1 sfw npm run client:install\n' +
    '\n' +
    '  Emergency bypass (must be logged in session_notes.md):\n' +
    '    SFW_BYPASS=1 npm install\n' +
    '\n' +
    '  See README.md, section "Security requirement: Socket Firewall".\n' +
    '\n'
);

process.exit(1);
