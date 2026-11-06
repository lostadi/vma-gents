import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStart } from "../src/start-cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.exitCode = await runStart(process.argv.slice(2), { root });
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
}
