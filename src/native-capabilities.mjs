import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG = path.resolve(here, "../capabilities/claude-native.json");
const DEFAULT_WORKER = path.resolve(here, "native-worker.cjs");
const MAX_ARGUMENT_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;

const OPERATION_DESCRIPTIONS = Object.freeze({
  "host.frontmostApp": "Inspect the frontmost application on the initiating macOS host.",
  "host.mouseLocation": "Inspect the pointer position on the initiating macOS host.",
  "host.authAvailable": "Ask the host native provider whether its authentication request facility is available.",
  "host.accessibilityPermission": "Inspect host accessibility permission status.",
  "host.screenRecordingPermission": "Inspect host screen recording permission status.",
  "host.displays": "List the host displays; this does not inspect a guest filesystem.",
  "host.runningApps": "List running host applications. Takes no arguments; does not run a command or read a file.",
  "host.processRunning": "Pass one string to the native host process query and receive a Boolean. Does not execute that string or inspect file contents.",
  "host.appForFile": "Find the host application associated with one host file path. Returns application metadata, not file contents or guest file evidence.",
  "host.typeText": "Type text through the host native provider; this is a host action.",
  "host.typeTextPaced": "Type paced text through the host provider. Optional argument types are not fully qualified.",
  "host.moveMouse": "Move the host pointer through the native provider; verify argument details before acting.",
  "host.mouseButton": "Send a host pointer button action. Optional argument types are not fully qualified.",
  "host.mouseScroll": "Send a host scrolling action. Optional argument types are not fully qualified.",
  "host.key": "Send a host key action. Optional argument types are not fully qualified.",
  "host.keys": "Send host key actions. Optional argument types are not fully qualified.",
  "host.focusWindow": "Focus a host window through the native provider. Optional argument types are not fully qualified.",
  "host.openApp": "Open a host application through the native provider. Optional argument types are not fully qualified.",
});

// Unknown native argument types stay unspecified. Arity comes from the same
// catalog used by call(); these two string inputs are source/probe grounded.
const KNOWN_ARGUMENTS = Object.freeze({
  "host.processRunning": [{ type: "string", description: "Native process query string; not a shell program." }],
  "host.appForFile": [{ type: "string", description: "Path to a file on the initiating macOS host." }],
});

function operationMetadata(operation) {
  return {
    description: OPERATION_DESCRIPTIONS[operation.name] ?? "Invoke this catalogued operation on the initiating host; consult its qualified native signature for argument types.",
    argsSchema: {
      type: "array",
      minItems: operation.minimumArguments,
      maxItems: operation.maximumArguments,
      ...(KNOWN_ARGUMENTS[operation.name] ? { prefixItems: KNOWN_ARGUMENTS[operation.name] } : {}),
      items: {},
    },
  };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function candidateRoots(environment) {
  const roots = [];
  if (environment.OVM_CLAUDE_EXTRACTED_ROOT) roots.push(environment.OVM_CLAUDE_EXTRACTED_ROOT);
  roots.push(
    path.resolve(here, "../host/native-root/current"),
    path.join(os.homedir(), "claude_extracted_binary_macos-master"),
    "/Applications/Claude.app/Contents/Resources/app.asar.unpacked",
  );
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function invokeWorker(workerPath, request, { timeoutMilliseconds = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      reject(new Error(`native capability worker exceeded ${timeoutMilliseconds}ms`));
    }, timeoutMilliseconds);
    const collect = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        throw new Error("native capability worker exceeded output limit");
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      try { stdout = collect(stdout, chunk); } catch (error) {
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
      }
    });
    child.stderr.on("data", (chunk) => {
      try { stderr = collect(stderr, chunk); } catch (error) {
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
      }
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let result;
      try {
        result = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(`native capability worker returned invalid JSON (exit=${code}, signal=${signal}, stderr=${stderr.trim()})`));
        return;
      }
      if (code !== 0 || result.ok !== true) {
        reject(new Error(result.error || stderr.trim() || `native capability worker failed (exit=${code}, signal=${signal})`));
        return;
      }
      resolve(result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export class NativeCapabilityBroker {
  constructor({
    catalogPath = DEFAULT_CATALOG,
    workerPath = DEFAULT_WORKER,
    environment = process.env,
    roots,
    allowAct = environment.OVM_NATIVE_ALLOW_ACT === "1",
    allowUnqualified = environment.OVM_NATIVE_ALLOW_UNQUALIFIED === "1",
  } = {}) {
    this.catalogPath = catalogPath;
    this.workerPath = workerPath;
    this.environment = environment;
    this.roots = roots ?? candidateRoots(environment);
    this.allowAct = allowAct;
    this.allowUnqualified = allowUnqualified;
    this.catalogPromise = null;
  }

  async catalog() {
    this.catalogPromise ??= readFile(this.catalogPath, "utf8").then((text) => JSON.parse(text));
    return this.catalogPromise;
  }

  async providers() {
    const catalog = await this.catalog();
    const states = {};
    for (const [name, provider] of Object.entries(catalog.providers)) {
      let state = {
        name,
        description: provider.description,
        available: false,
        qualified: false,
        callable: false,
        root: null,
        modulePath: null,
        binaryPath: null,
        sha256: null,
      };
      for (const root of this.roots) {
        const modulePath = path.join(root, provider.moduleRelativePath);
        const binaryPath = path.join(root, provider.binaryRelativePath);
        if (!existsSync(modulePath) || !existsSync(binaryPath)) continue;
        const digest = sha256(binaryPath);
        const qualified = provider.qualifiedSha256.includes(digest);
        state = {
          ...state,
          available: true,
          qualified,
          callable: qualified || this.allowUnqualified,
          root,
          modulePath,
          binaryPath,
          sha256: digest,
        };
        break;
      }
      states[name] = Object.freeze(state);
    }
    return Object.freeze(states);
  }

  async describe() {
    const catalog = await this.catalog();
    const providers = await this.providers();
    return {
      schema: catalog.schema,
      allowAct: this.allowAct,
      allowUnqualified: this.allowUnqualified,
      providers,
      operations: catalog.operations.map((operation) => ({
        ...operationMetadata(operation),
        ...operation,
        available: providers[operation.provider]?.callable === true,
        enabled: providers[operation.provider]?.callable === true
          && (operation.access === "observe" || this.allowAct),
      })),
    };
  }

  async probe() {
    const description = await this.describe();
    const probes = {};
    await Promise.all(Object.values(description.providers).map(async (provider) => {
      if (!provider.callable) {
        probes[provider.name] = { loaded: false, reason: provider.available ? "unqualified-hash" : "not-found" };
        return;
      }
      try {
        const result = await invokeWorker(this.workerPath, {
          action: "enumerate",
          modulePath: provider.modulePath,
        });
        probes[provider.name] = { loaded: true, exports: result.exports };
      } catch (error) {
        probes[provider.name] = { loaded: false, reason: error.message };
      }
    }));
    return { ...description, probes };
  }

  async call(operationName, args = []) {
    const encoded = JSON.stringify(args);
    if (Buffer.byteLength(encoded, "utf8") > MAX_ARGUMENT_BYTES) {
      throw new Error(`native capability arguments exceed ${MAX_ARGUMENT_BYTES} bytes`);
    }
    const catalog = await this.catalog();
    const operation = catalog.operations.find((candidate) => candidate.name === operationName);
    if (!operation) throw new Error(`unknown native capability: ${operationName}`);
    if (!Array.isArray(args)
      || args.length < operation.minimumArguments
      || args.length > operation.maximumArguments) {
      throw new Error(`${operationName} expects ${operation.minimumArguments}-${operation.maximumArguments} arguments`);
    }
    if (operation.access === "act" && !this.allowAct) {
      throw new Error(`${operationName} is a host action; set OVM_NATIVE_ALLOW_ACT=1 in the owner-controlled environment`);
    }
    const providers = await this.providers();
    const provider = providers[operation.provider];
    if (!provider?.available) throw new Error(`native provider is unavailable: ${operation.provider}`);
    if (!provider.callable) {
      throw new Error(`native provider hash is not qualified: ${operation.provider} (${provider.sha256})`);
    }
    const result = await invokeWorker(this.workerPath, {
      action: "call",
      modulePath: provider.modulePath,
      memberPath: operation.memberPath,
      args,
    });
    return {
      operation: operation.name,
      provider: operation.provider,
      providerSha256: provider.sha256,
      access: operation.access,
      evidence: operation.evidence,
      value: result.value,
    };
  }
}

export { invokeWorker };
