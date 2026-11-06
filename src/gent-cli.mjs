import path from "node:path";
import { runChild } from "./user-cli.mjs";

const SAVED_GENT_COMMANDS = new Set(["list", "show", "resume", "clone", "export", "import"]);

// Keep the established agent routes and state formats behind the gent front door.
// Arguments remain argv data, including prompts and paths containing shell syntax.
export function gentArguments(argv) {
  return SAVED_GENT_COMMANDS.has(argv[0]) ? ["agent", ...argv] : [...argv];
}

export function savedGentHelp(command) {
  const forms = {
    list: "gent list [--json]",
    show: "gent show ID [--json]",
    resume: 'gent resume ID ["new task"] [--rounds N] [--local | --on NAME] [--json]',
    clone: "gent clone ID NEW_ID [--json]",
    export: "gent export ID FILE.ovm [--json]",
    import: "gent import FILE.ovm [NEW_ID] [--private-model] [--json]",
  };
  if (!forms[command]) return null;
  return `Usage: ${forms[command]}\n\nA gent is an autonomous agent with its own persistent Linux VM.\nSaved gents retain their files and history. Export and clone require the gent\nto be stopped, and include its full local model weights. Existing .ovm capsules\nand saved agents remain compatible. --private-model keeps imported weights in\nthe gent's private model store without publishing another host copy.\n`;
}

export async function runGent(argv, { root, run = runChild, output = process.stdout, environment = process.env } = {}) {
  if (argv[0] === 'browser') {
    return run(process.execPath, [path.join(root, 'bin/ovm-browser'), ...argv.slice(1)], { env: environment });
  }
  const end = argv.indexOf("--");
  const options = end < 0 ? argv : argv.slice(0, end);
  const help = savedGentHelp(argv[0]);
  if (help && options.some(arg => arg === "--help" || arg === "-h")) {
    output.write(help);
    return 0;
  }
  return run(process.execPath, [path.join(root, "bin/ovm"), ...gentArguments(argv)], { env: environment });
}
