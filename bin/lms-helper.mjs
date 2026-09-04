#!/usr/bin/env node
// Subcommand dispatcher so the scripts can be run as a single command without
// pnpm/npm/corepack (see README "Running without pnpm"). Symlink this file
// (without the .mjs extension) into a directory on $PATH:
//   ln -s "$(pwd)/bin/lms-helper.mjs" ~/bin/lms-helper
// Node resolves the symlink to its real path, so the relative import below
// keeps working no matter where it's linked from.

const [, , cmd, ...rest] = process.argv;

const COMMANDS = {
  ls: "list-models.mjs",
  outdated: "outdated-models.mjs",
  rm: "remove-model.mjs",
  redownload: "redownload-model.mjs",
};

function usage() {
  console.error(`Usage: lms-helper <${Object.keys(COMMANDS).join("|")}> [...args]`);
}

if (!cmd || cmd === "-h" || cmd === "--help") {
  usage();
  process.exit(cmd ? 0 : 1);
}

const target = COMMANDS[cmd];
if (!target) {
  console.error(`Unknown command "${cmd}".\n`);
  usage();
  process.exit(1);
}

// Re-point argv so the target script's own `process.argv.slice(2)` sees just
// the forwarded args, not the subcommand name.
process.argv = [process.argv[0], process.argv[1], ...rest];
await import(`../scripts/${target}`);
