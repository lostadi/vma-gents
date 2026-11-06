import path from "node:path";
import { runChild } from "./user-cli.mjs";

// Terminal input belongs to a person; a no-argument pipe preserves the MCP
// transport. Explicit arguments belong to chat, including its safe --help.
export async function runStart(argv, {
  root, input = process.stdin, progress = process.stderr,
  environment = process.env, run = runChild,
} = {}) {
  if (input.isTTY || argv.length) {
    if (input.isTTY && !argv.includes("--help") && !argv.includes("-h")) {
      progress.write("Opening o-gents chat. /bye exits. For the MCP server, use npm run mcp.\n");
    }
    return run(process.execPath, [path.join(root, "bin/gent"), "chat", ...argv], { env: environment });
  }
  return run(path.join(root, "bin/claude-vm-mcp"), [], { env: environment });
}
