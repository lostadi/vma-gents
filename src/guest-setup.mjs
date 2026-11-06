import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function guestRunnerArguments({ projectRoot, bundlePath, sharePath, exportShare,
  proxyUnixSocket, memoryMB, cpuCount }) {
  for (const [name, value, minimum, maximum] of [
    ["memoryMB", memoryMB, 512, 8192], ["cpuCount", cpuCount, 1, 8],
  ]) {
    if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > maximum)) {
      throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
  }
  return [
    "--bundle", bundlePath, "--smol", path.join(projectRoot, "host/smol-bin.arm64.img"),
    "--share", sharePath,
    "--network", proxyUnixSocket ? "isolated" : "nat", "--provision",
    ...(exportShare ? ["--export-share", exportShare] : []),
    ...(proxyUnixSocket ? ["--proxy-socket", proxyUnixSocket] : []),
    ...(memoryMB !== undefined ? ["--memory-mb", String(memoryMB)] : []),
    ...(cpuCount !== undefined ? ["--cpu-count", String(cpuCount)] : []),
  ];
}

// The guest runs the supplied script as data, with a result marker owned by
// this controller. A stopped VM alone is not proof that installation passed.
export async function runGuestScript({ projectRoot, bundlePath, sharePath, script,
  logPath, exportShare, proxyUnixSocket, memoryMB, cpuCount,
  timeoutMs = 60 * 60 * 1000, onOutput = () => {} }) {
  const arguments_ = guestRunnerArguments({ projectRoot, bundlePath, sharePath,
    exportShare, proxyUnixSocket, memoryMB, cpuCount });
  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const token = `OVM_SETUP_${randomUUID().replaceAll("-", "")}`;
  const scriptName = `.ovm-command-${token}.sh`;
  await writeFile(path.join(sharePath, scriptName), script, { mode: 0o600, flag: "wx" });
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(projectRoot, "host/OVMShell"), arguments_,
      { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", started = false, guestExit = null, failure = null;
    const kill = (reason) => { failure ??= new Error(reason); child.kill("SIGKILL"); };
    const timer = setTimeout(() => kill(`Guest setup exceeded ${timeoutMs / 1000} seconds; log: ${logPath}`), timeoutMs);
    const interrupt = () => kill(`Guest setup interrupted; staging image retained. Log: ${logPath}`);
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    const receive = (chunk) => {
      log.write(chunk); onOutput(chunk.toString());
      buffer = (buffer + chunk.toString()).slice(-131072);
      if (!started && /(?:root@[^\r\n]*#|bash-[\d.]+#)/.test(buffer)) {
        started = true;
        child.stdin.write(`stty -echo\nmount -t proc proc /proc 2>/dev/null; mount -t sysfs sysfs /sys 2>/dev/null; mount -t devpts devpts /dev/pts 2>/dev/null\n[ -e /dev/fd ] || ln -s /proc/self/fd /dev/fd\nmkdir -p /mnt/ovm-provision\nmount -t virtiofs claudeshared /mnt/ovm-provision\nbash /mnt/ovm-provision/${scriptName}; ovm_rc=$?; printf '\\n${token}:%s\\n' "$ovm_rc"; sync; poweroff -f\n`);
      }
      const match = buffer.match(new RegExp(`(?:^|[\\r\\n])${token}:(\\d+)(?:[\\r\\n]|$)`));
      if (match) guestExit = Number(match[1]);
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    child.stdin.on("error", () => {});
    child.once("error", (error) => { failure = error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
      log.end(() => {
        if (failure) reject(failure);
        else if (guestExit !== 0 || code !== 0) reject(new Error(`Guest setup failed (guest=${guestExit}, runner=${code}, signal=${signal}); log: ${logPath}`));
        else resolve({ guestExit, logPath });
      });
    });
  });
}

export async function cloneProvisionBundle(projectRoot, destination) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  // macOS cp -c uses APFS copy-on-write. Never fall back to a full image copy.
  await execute("/bin/cp", ["-c", "-R", "-p", path.join(projectRoot, "vm/claudevm.bundle"), destination]);
}
