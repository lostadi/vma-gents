import { createHash, randomUUID } from 'node:crypto';
import { shellQuote } from './controller-transport.mjs';

export const MAX_OSTADIX_SOURCE_BYTES = 8192;
export const MAX_OSTADIX_OUTPUT_BYTES = 16 * 1024;
const MAX_RECEIPT_BYTES = 400 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const RECEIPT_SCHEMA = 'ovm.ostadix-execution/v1';
const hash = value => createHash('sha256').update(value).digest('hex');

function boundedText(value, name, maximum, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || Buffer.byteLength(value, 'utf8') > maximum || Buffer.from(value).toString('utf8') !== value) {
    throw new Error(`${name} must be ${empty ? 'a' : 'a nonempty'} UTF-8 string of at most ${maximum} bytes`);
  }
  return value;
}

export function normalizeOstadixAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || action.type !== 'ostadix') throw new Error('Expected an ostadix action');
  const source = boundedText(action.source, 'Ostadix source', MAX_OSTADIX_SOURCE_BYTES);
  const name = boundedText(action.name ?? 'program', 'Ostadix program name', 128);
  const mode = action.mode ?? 'check';
  if (!['check', 'run'].includes(mode)) throw new Error('Ostadix mode must be check or run');
  if (!Array.isArray(action.checks ?? []) || (action.checks?.length ?? 0) > 8) throw new Error('Ostadix checks must contain at most eight output predicates');
  const checks = (action.checks ?? []).map(check => {
    if (!check || !['stdout_equals', 'stdout_contains'].includes(check.kind)) throw new Error('Ostadix checks support stdout_equals or stdout_contains');
    const expected = boundedText(check.expected, 'Ostadix expected output', 4096, { empty: true });
    if (check.kind === 'stdout_contains' && !expected.length) throw new Error('Ostadix stdout_contains requires a nonempty expected substring');
    return Object.freeze({ kind: check.kind, expected });
  });
  if (mode === 'run' && !checks.length) throw new Error('Ostadix run requires at least one explicit output check');
  return Object.freeze({ type: 'ostadix', source, name, mode, checks: Object.freeze(checks) });
}

// The controller builds this program, but the fleet executes it only inside the
// requesting gent's guest. Source is data until the digest-bound native O call.
function guestScript(ostadix) {
  const payload = Buffer.from(JSON.stringify(ostadix)).toString('base64');
  return `import base64, hashlib, json, os, selectors, shutil, signal, subprocess, tempfile, time
payload = json.loads(base64.b64decode(${JSON.stringify(payload)}))
OUTPUT_LIMIT = ${MAX_OSTADIX_OUTPUT_BYTES}
PHASE_TIMEOUT_SECONDS = 15
env = dict(os.environ)
root = env.get("O_LANG_ROOT", "/opt/ostadix")
backends = env.get("O_BACKENDS_DIR", os.path.join(root, "backends"))
env["O_LANG_ROOT"] = root
env["O_BACKENDS_DIR"] = backends
env.setdefault("PATH", "/usr/local/bin:/opt/ostadix-toolchain/bin:/usr/bin:/bin")
receipt = {"schema": ${JSON.stringify(RECEIPT_SCHEMA)}, "sourceSha256": payload["sourceSha256"], "mode": payload["mode"], "parse": None, "intent": None, "execution": None, "error": None}

def run_phase(argv):
    result = {"exitCode": None, "stdout": "", "stderr": "", "timedOut": False, "outputLimitExceeded": False}
    try:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
    except OSError as error:
        result.update(exitCode=127, error=str(error).encode("utf-8")[:4096].decode("utf-8", errors="ignore"))
        return result
    streams = selectors.DefaultSelector()
    chunks = {"stdout": bytearray(), "stderr": bytearray()}
    total = 0
    deadline = time.monotonic() + PHASE_TIMEOUT_SECONDS
    for name in chunks:
        stream = getattr(child, name)
        os.set_blocking(stream.fileno(), False)
        streams.register(stream, selectors.EVENT_READ, name)
    try:
        while streams.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                result["timedOut"] = True
                break
            for key, _ in streams.select(min(remaining, 0.1)):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    streams.unregister(key.fileobj)
                    continue
                retain = min(len(chunk), max(0, OUTPUT_LIMIT - total))
                chunks[key.data].extend(chunk[:retain])
                total += len(chunk)
                if total > OUTPUT_LIMIT:
                    result["outputLimitExceeded"] = True
                    break
            if result["outputLimitExceeded"]:
                break
        if not result["timedOut"] and not result["outputLimitExceeded"]:
            try:
                child.wait(timeout=max(0.001, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                result["timedOut"] = True
    finally:
        # A finished evaluator must not leave its backend descendants running.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        streams.close()
        child.stdout.close()
        child.stderr.close()
    result["exitCode"] = 124 if result["timedOut"] else 125 if result["outputLimitExceeded"] else child.returncode if child.returncode >= 0 else 128 - child.returncode
    for name, data in chunks.items():
        try:
            result[name] = data.decode("utf-8")
        except UnicodeDecodeError:
            result[name] = data.decode("utf-8", errors="replace")[:OUTPUT_LIMIT]
            result["error"] = "Native output is not valid UTF-8; no output predicate can pass"
    return result

def completed(phase):
    return phase["exitCode"] == 0 and not phase.get("error") and not phase["timedOut"] and not phase["outputLimitExceeded"]

def check_diagnostics(parsed):
    if not isinstance(parsed, dict) or parsed.get("ok") is not True or parsed.get("stage") != "parse":
        raise ValueError("Native O parser did not report a successful parse")
    structure = parsed.get("source_structure")
    if not isinstance(structure, dict) or structure.get("schema") != "ostadix.source-structure/v1" or not isinstance(structure.get("backend_syntax_checks"), list) or not isinstance(structure.get("required_initial_bindings"), list) or not isinstance(structure.get("top_level_literal_text"), bool):
        raise ValueError("Native O lacks structured source diagnostics; update the guest runtime")
    if structure["required_initial_bindings"]:
        raise ValueError("O source requires undefined initial bindings: " + json.dumps(structure["required_initial_bindings"])[:1024])
    if structure["top_level_literal_text"]:
        raise ValueError("O source contains top-level literal text; use recognized backend delimiters and keep explanations outside source")
    if any(not isinstance(item, dict) or item.get("state") not in ("valid", "invalid", "skipped", "unavailable") for item in structure["backend_syntax_checks"]):
        raise ValueError("Native O returned unsupported backend syntax diagnostics")
    if any(item.get("state") == "invalid" for item in structure["backend_syntax_checks"]):
        raise ValueError("Native backend syntax diagnostics contain an invalid program")

try:
    if not os.path.isabs(root) or not os.path.isabs(backends):
        raise ValueError("Ostadix root and backends must be absolute guest paths")
    evaluator = shutil.which("O", path=env["PATH"])
    compiler = shutil.which("olangc", path=env["PATH"])
    if not evaluator or not compiler:
        raise FileNotFoundError("O and olangc must be installed in the guest")
    source = payload["source"].encode("utf-8")
    if hashlib.sha256(source).hexdigest() != payload["sourceSha256"]:
        raise ValueError("Submitted Ostadix source identity changed")
    with tempfile.TemporaryDirectory(prefix="o-gent-program-") as directory:
        program = os.path.join(directory, "program.O")
        descriptor = os.open(program, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(source)
        receipt["parse"] = run_phase([evaluator, "--check", "--json", program, backends])
        if not completed(receipt["parse"]):
            raise ValueError("Native O source check failed")
        check_diagnostics(json.loads(receipt["parse"]["stdout"]))
        receipt["intent"] = run_phase([compiler, program, "--target", "ir", "--execution-intent-json"])
        if not completed(receipt["intent"]):
            raise ValueError("Native O execution-intent inspection failed")
        intent = json.loads(receipt["intent"]["stdout"])
        digest = intent.get("execution_intent_sha256", "")
        if intent.get("schema") != "oexec.execution-intent/v1" or intent.get("source_sha256") != payload["sourceSha256"] or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("Native O execution intent does not identify the submitted source")
        if payload["mode"] == "run":
            receipt["execution"] = run_phase([evaluator, "--require-source-sha256", payload["sourceSha256"], "--require-execution-intent-sha256", digest, program, backends])
except Exception as error:
    receipt["error"] = str(error).encode("utf-8")[:4096].decode("utf-8", errors="ignore")
print(payload["token"] + json.dumps(receipt, ensure_ascii=True, separators=(",", ":")))
`;
}

export function buildOstadixTask(action, agent, { round, reviewOf = null } = {}) {
  const normalized = normalizeOstadixAction(action);
  if (typeof agent?.id !== 'string' || !agent.id) throw new Error('Ostadix task requires a gent identity');
  if (!Number.isSafeInteger(round) || round < 1) throw new Error('Ostadix task requires a positive round');
  const { type: _type, ...program } = normalized;
  const ostadix = { ...program, sourceSha256: hash(normalized.source), token: `OVM_OSTADIX_${randomUUID().replaceAll('-', '')}`, round, reviewOf: structuredClone(reviewOf) };
  return { agentId: agent.id, command: `python3 -c ${shellQuote(guestScript(ostadix))}`, artifactCapture: true, ostadix };
}

function nativePhase(phase, name) {
  if (phase === null) return null;
  if (!phase || typeof phase !== 'object' || !Number.isInteger(phase.exitCode) || phase.exitCode < 0 || phase.exitCode > 255 || typeof phase.timedOut !== 'boolean' || typeof phase.outputLimitExceeded !== 'boolean') throw new Error(`Invalid Ostadix ${name} receipt`);
  const result = {
    exitCode: phase.exitCode,
    stdout: boundedText(phase.stdout, `Ostadix ${name} stdout`, MAX_OSTADIX_OUTPUT_BYTES * 3, { empty: true }),
    stderr: boundedText(phase.stderr, `Ostadix ${name} stderr`, MAX_OSTADIX_OUTPUT_BYTES * 3, { empty: true }),
    timedOut: phase.timedOut,
    outputLimitExceeded: phase.outputLimitExceeded,
    ...(phase.error ? { error: boundedText(phase.error, `Ostadix ${name} error`, 4096) } : {}),
  };
  if (!phase.error && Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OSTADIX_OUTPUT_BYTES) throw new Error(`Ostadix ${name} exceeded its combined output budget`);
  return result;
}

const complete = phase => Boolean(phase && phase.exitCode === 0 && !phase.error && !phase.timedOut && !phase.outputLimitExceeded);

export function acceptOstadixResult(task, worker) {
  const program = task.ostadix;
  if (!program || hash(program.source) !== program.sourceSha256 || !SHA256.test(program.sourceSha256)) throw new Error('Ostadix task source identity is invalid');
  normalizeOstadixAction({ ...program, type: 'ostadix' });
  if (worker?.agent !== task.agentId || worker.stopped !== true || worker.error || worker.exitCode !== 0) throw new Error('Ostadix receipt requires a successful correlated stopped-VM worker');
  if (typeof worker.output !== 'string' || Buffer.byteLength(worker.output) > MAX_RECEIPT_BYTES) throw new Error('Ostadix receipt is missing or exceeds its output budget');
  const lines = worker.output.split(/\r?\n/).filter(line => line.startsWith(program.token));
  if (lines.length !== 1) throw new Error('Ostadix returned no unique complete receipt');
  const receipt = JSON.parse(lines[0].slice(program.token.length));
  if (receipt.schema !== RECEIPT_SCHEMA || receipt.sourceSha256 !== program.sourceSha256 || receipt.mode !== program.mode) throw new Error('Ostadix receipt does not match its submitted source and mode');
  const parse = nativePhase(receipt.parse, 'parse');
  const intent = nativePhase(receipt.intent, 'intent');
  const execution = nativePhase(receipt.execution, 'execution');
  if (program.mode === 'check' && execution) throw new Error('Static Ostadix check returned an unexpected execution');
  const diagnostics = [];
  let sourceStructure = null, executionIntentSha256 = null;
  let staticPassed = complete(parse) && complete(intent);
  if (parse) {
    try {
      const value = JSON.parse(parse.stdout);
      sourceStructure = value.source_structure ?? null;
      if (value.ok !== true || value.stage !== 'parse' || sourceStructure?.schema !== 'ostadix.source-structure/v1' || !Array.isArray(sourceStructure.backend_syntax_checks) || !Array.isArray(sourceStructure.required_initial_bindings) || typeof sourceStructure.top_level_literal_text !== 'boolean') throw new Error('Native source diagnostics are missing or unsuccessful');
      diagnostics.push(...sourceStructure.backend_syntax_checks.slice(0, 64));
      if (sourceStructure.required_initial_bindings.length || sourceStructure.top_level_literal_text || sourceStructure.backend_syntax_checks.some(item => !['valid', 'skipped', 'unavailable'].includes(item?.state))) staticPassed = false;
    } catch { staticPassed = false; }
  }
  if (intent) {
    try {
      const value = JSON.parse(intent.stdout);
      if (value.schema !== 'oexec.execution-intent/v1' || value.source_sha256 !== program.sourceSha256 || !SHA256.test(value.execution_intent_sha256)) throw new Error('Native source intent does not match');
      executionIntentSha256 = value.execution_intent_sha256;
    } catch { staticPassed = false; }
  }
  const error = receipt.error === null ? null : boundedText(receipt.error, 'Ostadix receipt error', 4096);
  if (error) staticPassed = false;
  if (execution && !staticPassed) throw new Error('Ostadix execution lacks a successful source check and bound native intent');
  const stdout = execution?.stdout ?? '';
  const checks = program.checks.map(check => ({ ...check, passed: Boolean(staticPassed && complete(execution) && (check.kind === 'stdout_equals' ? stdout === check.expected : stdout.includes(check.expected))) }));
  const success = program.mode === 'check' ? staticPassed : staticPassed && complete(execution) && checks.length > 0 && checks.every(check => check.passed);
  return {
    sourceSha256: program.sourceSha256, executionIntentSha256, mode: program.mode,
    executed: execution !== null,
    checkStatus: success ? program.mode === 'run' ? 'checks-passed' : 'static-check-passed' : program.mode === 'run' ? 'checks-failed' : 'static-check-failed',
    checks, success, stdout, stderr: execution?.stderr ?? intent?.stderr ?? parse?.stderr ?? '',
    exitCode: execution?.exitCode ?? (success ? 0 : intent?.exitCode || parse?.exitCode || 1),
    parse, intent, execution, diagnostics, sourceStructure, error,
    meaning: 'Native source parsing and source-bound execution intent; output checks establish only their explicit predicates, not program or mission correctness. Skipped syntax diagnostics remain unchecked.',
  };
}
