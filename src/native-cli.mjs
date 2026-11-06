import { NativeCapabilityBroker } from "./native-capabilities.mjs";

function usage() {
  return `usage:
  gent native probe [--json]
  gent native list [--json]
  gent native call OPERATION [JSON_ARRAY] [--json]

Host-changing operations require OVM_NATIVE_ALLOW_ACT=1.`;
}

export async function runNativeCli(argv, { output = process.stdout, errorOutput = process.stderr } = {}) {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const command = args[0] ?? "probe";
  const broker = new NativeCapabilityBroker();
  let result;
  if (command === "probe") result = await broker.probe();
  else if (command === "list") result = await broker.describe();
  else if (command === "call") {
    if (!args[1]) throw new Error(usage());
    let callArgs = [];
    if (args[2]) {
      callArgs = JSON.parse(args[2]);
      if (!Array.isArray(callArgs)) throw new Error("native call arguments must be a JSON array");
    }
    result = await broker.call(args[1], callArgs);
  } else if (["help", "--help", "-h"].includes(command)) {
    output.write(`${usage()}\n`);
    return 0;
  } else {
    throw new Error(`unknown native command: ${command}\n${usage()}`);
  }
  if (json) output.write(`${JSON.stringify(result)}\n`);
  else output.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
