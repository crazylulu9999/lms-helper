#!/usr/bin/env node
// Subcommand dispatcher so the scripts can be run as a single command without
// pnpm/npm/corepack (see README "Running without pnpm"). Symlink this file
// (without the .mjs extension) into a directory on $PATH:
//   ln -s "$(pwd)/bin/lms-helper.mjs" ~/bin/lms-helper
// Node resolves the symlink to its real path, so the relative import below
// keeps working no matter where it's linked from.

import { c } from "../scripts/lib/lms.mjs";

const [, , cmd, ...rest] = process.argv;

const COMMANDS = {
  ls: { file: "list-models.mjs", desc: "List downloaded models (size, path, vision/mmproj check)" },
  outdated: { file: "outdated-models.mjs", desc: "List models with an update available upstream" },
  rm: { file: "remove-model.mjs", desc: "Delete a downloaded model from disk" },
  redownload: { file: "redownload-model.mjs", desc: "Delete then re-download a model (force-update)" },
};

function usage() {
  console.error(`Usage: ${c.bold("lms-helper")} <command> [...args]\n`);
  console.error("Commands:");
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, { desc }] of Object.entries(COMMANDS)) {
    console.error(`  ${c.cyan(name.padEnd(width))}  ${c.dim(desc)}`);
  }
  console.error(`\nRun \`lms-helper <command> --help\` for options.`);
}

if (!cmd || cmd === "-h" || cmd === "--help") {
  usage();
  process.exit(cmd ? 0 : 1);
}

const target = COMMANDS[cmd]?.file;
if (!target) {
  console.error(`Unknown command "${cmd}".\n`);
  usage();
  process.exit(1);
}

// Re-point argv so the target script's own `process.argv.slice(2)` sees just
// the forwarded args, not the subcommand name.
process.argv = [process.argv[0], process.argv[1], ...rest];
await import(`../scripts/${target}`);
