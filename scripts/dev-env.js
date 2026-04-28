'use strict';
// Tiny preload that flips FAMILY_GRAPH_ENV to development before the server boots.
// Used by the `npm run dev` script so the same incantation works in
// bash, cmd, and PowerShell (the bash-only `VAR=value cmd` form does not
// work on Windows shells).
process.env.FAMILY_GRAPH_ENV = 'development';
