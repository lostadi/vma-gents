import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const GUEST_PROGRAM_ROOT = /^\/(?:bin|usr\/(?:local\/)?bin)\/[A-Za-z0-9._+-]+$/;
const HARD_MAXIMUM_ARGUMENTS = 8;
const HARD_MAXIMUM_ARGUMENT_BYTES = 1024;
const HARD_MAXIMUM_ARGUMENT_LENGTH = 256;
const HARD_MAXIMUM_TIMEOUT_SECONDS = 30;
const HARD_MAXIMUM_OUTPUT_BYTES = 32 * 1024;
const BUILTIN_GUEST_PROGRAMS = Object.freeze({
  uname: Object.freeze({
    path: "/usr/bin/uname",
    allowedArgv: Object.freeze([
      Object.freeze([]),
      Object.freeze(["-a"]),
      Object.freeze(["-m"]),
      Object.freeze(["-r"]),
      Object.freeze(["-s"]),
    ]),
  }),
  id: Object.freeze({
    path: "/usr/bin/id",
    allowedArgv: Object.freeze([
      Object.freeze([]),
      Object.freeze(["-u"]),
      Object.freeze(["-g"]),
    ]),
  }),
  python3: Object.freeze({
    path: "/usr/bin/python3",
    allowedArgv: Object.freeze([Object.freeze(["--version"])]),
  }),
  git: Object.freeze({
    path: "/usr/bin/git",
    allowedArgv: Object.freeze([Object.freeze(["--version"])]),
  }),
});
const FIXED_GUEST_ENV = Object.freeze({
  HOME: "/nonexistent",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
});
const POLICY_KEYS = new Set([
  "memoryGB",
  "cpuCount",
  "networkMode",
  "startupTimeoutSeconds",
  "minimumFreeMemoryPercent",
  "minimumFreeDiskGiB",
  "defaultTimeoutSeconds",
  "maximumTimeoutSeconds",
  "maximumOutputBytes",
  "maximumArguments",
  "maximumArgumentBytes",
  "programs",
]);

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export async function loadPolicy(policyPath) {
  const metadata = await lstat(policyPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("policy path must be a regular, non-symlink file");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("policy file must be owned by the current user");
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error("policy file must not be writable by group or other users");
  }
  const canonicalPolicyPath = await realpath(policyPath);
  const raw = JSON.parse(await readFile(policyPath, "utf8"));
  const programs = Object.create(null);

  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).some((key) => !POLICY_KEYS.has(key))) {
    throw new Error("policy contains an unsupported top-level field");
  }

  if (!["nat", "isolated"].includes(raw.networkMode)) {
    throw new Error("guest execution policy requires networkMode to be nat or isolated");
  }

  if (!raw.programs || typeof raw.programs !== "object" || Array.isArray(raw.programs)) {
    throw new Error("policy.programs must be an object");
  }

  const maximumArguments = positiveInteger(
    raw.maximumArguments ?? HARD_MAXIMUM_ARGUMENTS,
    "maximumArguments",
    HARD_MAXIMUM_ARGUMENTS,
  );
  const maximumArgumentBytes = positiveInteger(
    raw.maximumArgumentBytes ?? HARD_MAXIMUM_ARGUMENT_BYTES,
    "maximumArgumentBytes",
    HARD_MAXIMUM_ARGUMENT_BYTES,
  );
  const defaultTimeoutSeconds = positiveInteger(
    raw.defaultTimeoutSeconds,
    "defaultTimeoutSeconds",
    HARD_MAXIMUM_TIMEOUT_SECONDS,
  );
  const maximumTimeoutSeconds = positiveInteger(
    raw.maximumTimeoutSeconds,
    "maximumTimeoutSeconds",
    HARD_MAXIMUM_TIMEOUT_SECONDS,
  );
  const maximumOutputBytes = positiveInteger(
    raw.maximumOutputBytes,
    "maximumOutputBytes",
    HARD_MAXIMUM_OUTPUT_BYTES,
  );
  if (defaultTimeoutSeconds > maximumTimeoutSeconds) {
    throw new Error("defaultTimeoutSeconds cannot exceed maximumTimeoutSeconds");
  }

  const programEntries = Object.entries(raw.programs);
  if (programEntries.length < 1) {
    throw new Error("policy.programs must contain at least one built-in program");
  }

  for (const [name, entry] of programEntries) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
      throw new Error(`invalid policy program name: ${name}`);
    }
    if (!Object.hasOwn(BUILTIN_GUEST_PROGRAMS, name)) {
      throw new Error(`program is not in the built-in guest allowlist: ${name}`);
    }
    const builtin = BUILTIN_GUEST_PROGRAMS[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => key !== "path" && key !== "allowedArgv")
      || typeof entry.path !== "string" || !GUEST_PROGRAM_ROOT.test(entry.path)) {
      throw new Error(`invalid fixed guest path for program: ${name}`);
    }
    if (entry.path !== builtin.path) {
      throw new Error(`guest path does not match the built-in allowlist for program: ${name}`);
    }
    const allowedArgv = entry.allowedArgv;
    if (!Array.isArray(allowedArgv) || allowedArgv.length < 1
      || allowedArgv.length > builtin.allowedArgv.length) {
      throw new Error(`invalid allowedArgv for program: ${name}`);
    }

    const seen = new Set();
    const builtinArgv = new Set(builtin.allowedArgv.map((argv) => JSON.stringify(argv)));
    const invocations = allowedArgv.map((argv) => {
      if (!Array.isArray(argv) || argv.length > maximumArguments) {
        throw new Error(`invalid allowedArgv for program: ${name}`);
      }
      let argumentBytes = 0;
      for (const arg of argv) {
        if (typeof arg !== "string" || arg.length > HARD_MAXIMUM_ARGUMENT_LENGTH || arg.includes("\0")) {
          throw new Error(`invalid allowedArgv for program: ${name}`);
        }
        argumentBytes += Buffer.byteLength(arg, "utf8") + 1;
      }
      if (argumentBytes > maximumArgumentBytes) {
        throw new Error(`allowedArgv exceeds maximumArgumentBytes for program: ${name}`);
      }
      const key = JSON.stringify(argv);
      if (!builtinArgv.has(key)) {
        throw new Error(`argv exceeds the built-in allowlist for program: ${name}`);
      }
      if (seen.has(key)) throw new Error(`duplicate allowedArgv for program: ${name}`);
      seen.add(key);
      return Object.freeze([...argv]);
    });

    programs[name] = Object.freeze({
      path: entry.path,
      allowedArgv: Object.freeze(invocations),
    });
  }

  return Object.freeze({
    path: path.resolve(canonicalPolicyPath),
    memoryGB: positiveInteger(raw.memoryGB, "memoryGB", 8),
    cpuCount: positiveInteger(raw.cpuCount, "cpuCount", 8),
    networkMode: raw.networkMode,
    startupTimeoutSeconds: positiveInteger(raw.startupTimeoutSeconds ?? 120, "startupTimeoutSeconds", 300),
    minimumFreeMemoryPercent: positiveInteger(
      raw.minimumFreeMemoryPercent,
      "minimumFreeMemoryPercent",
      100,
    ),
    minimumFreeDiskGiB: positiveInteger(raw.minimumFreeDiskGiB, "minimumFreeDiskGiB", 1024),
    defaultTimeoutSeconds,
    maximumTimeoutSeconds,
    maximumOutputBytes,
    maximumArguments,
    maximumArgumentBytes,
    programs: Object.freeze(programs),
  });
}

export function validateInvocation(policy, program, args, timeoutSeconds) {
  const entry = policy.programs[program];
  if (!entry) {
    throw new Error(`program is not allowlisted: ${program}`);
  }
  if (!Array.isArray(args) || args.length > policy.maximumArguments) {
    throw new Error(`args must be an array with at most ${policy.maximumArguments} entries`);
  }
  let argumentBytes = 0;
  for (const arg of args) {
    if (typeof arg !== "string" || arg.length > HARD_MAXIMUM_ARGUMENT_LENGTH || arg.includes("\0")) {
      throw new Error(
        `each argument must be a NUL-free string of at most ${HARD_MAXIMUM_ARGUMENT_LENGTH} characters`,
      );
    }
    argumentBytes += Buffer.byteLength(arg, "utf8") + 1;
  }
  if (argumentBytes > policy.maximumArgumentBytes) {
    throw new Error(`args exceed the ${policy.maximumArgumentBytes}-byte argv limit`);
  }
  const allowed = entry.allowedArgv.some((candidate) =>
    candidate.length === args.length && candidate.every((value, index) => value === args[index]));
  if (!allowed) {
    throw new Error(`argv is not allowlisted for ${program}`);
  }
  const timeout = timeoutSeconds ?? policy.defaultTimeoutSeconds;
  positiveInteger(timeout, "timeoutSeconds", policy.maximumTimeoutSeconds);
  return Object.freeze({
    command: entry.path,
    args: Object.freeze([...args]),
    cwd: "/",
    env: FIXED_GUEST_ENV,
    timeoutSeconds: timeout,
  });
}
