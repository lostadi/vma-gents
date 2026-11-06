import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shellQuote } from './controller-transport.mjs';
import { normalizeOstadixAction } from './ostadix-control.mjs';

export const MAX_ARTIFACT_BYTES = 256 * 1024;
export const MAX_ARTIFACT_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_ARTIFACT_COUNT = 64;
const MAX_ARTIFACT_INDEX_BYTES = 256 * 1024;
const MAX_ARTIFACT_PUBLICATIONS = 1024;
const SHA = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const OSTADIX_ID = /^ostadix:[a-f0-9]{64}$/;
function identityText(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 256) throw new Error(`Invalid OSTADIX artifact ${label}`);
  return value;
}
function ostadixIdentity(artifact) {
  return hash(JSON.stringify({ schema: 'ovm.ostadix-artifact-contract/v1', sourceSha256: artifact.sha256,
    checks: artifact.code.contract.checks, producer: artifact.producer, round: artifact.round,
    instanceId: artifact.code.producerInstanceId, evidenceId: artifact.code.executionEvidenceId,
    name: artifact.name, swarmId: artifact.swarmId }));
}
function serializeIndex(artifacts) {
  if (artifacts.length > MAX_ARTIFACT_PUBLICATIONS) throw new Error('Artifact index exceeds 1024 publications');
  const serialized = JSON.stringify({ schema: 'ovm.artifacts/v1', artifacts }, null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ARTIFACT_INDEX_BYTES) throw new Error('Artifact index exceeds 256 KiB; publish smaller contracts or fewer publications');
  return serialized;
}
async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Artifact store must be a real directory');
}
async function boundedRead(file, maximum = MAX_ARTIFACT_BYTES) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw new Error('Artifact store contains an invalid file');
    return await handle.readFile();
  } finally { await handle.close(); }
}

export function buildCaptureTask(action, agent, { round }) {
  if (typeof action.path !== 'string' || !action.path.startsWith('/') || action.path.includes('\0') || action.path.length > 2048) throw new Error('Publish requires an absolute guest file path');
  if (typeof action.name !== 'string' || !action.name.trim() || action.name.length > 128) throw new Error('Publish requires a name up to 128 characters');
  const token = `OVM_ARTIFACT_${randomUUID().replaceAll('-', '')}`;
  const script = `import os, stat, json, hashlib, base64\np=${JSON.stringify(action.path)}\nf=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)\ntry:\n before=os.fstat(f)\n if not stat.S_ISREG(before.st_mode): raise ValueError("Publish requires a regular file")\n if before.st_size>${MAX_ARTIFACT_BYTES}: raise ValueError("Artifact exceeds 256 KiB; publish a focused result or manifest")\n data=b""\n while len(data)<=${MAX_ARTIFACT_BYTES}:\n  part=os.read(f,min(65536,${MAX_ARTIFACT_BYTES}+1-len(data)))\n  if not part: break\n  data+=part\n after=os.fstat(f)\n if len(data)>${MAX_ARTIFACT_BYTES} or (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns): raise ValueError("Artifact changed while reading")\n print(${JSON.stringify(token)}+json.dumps({"schema":"ovm.artifact-capture/v1","sha256":hashlib.sha256(data).hexdigest(),"bytes":len(data),"base64":base64.b64encode(data).decode("ascii")}))\nfinally:\n os.close(f)\n`;
  return { agentId: agent.id, command: `python3 -c ${shellQuote(script)}`, artifactPublication: { name: action.name.trim(), sourcePath: action.path, token, round, producer: agent.id } };
}

async function blobNames(directory) {
  return (await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => /^sha256-[a-f0-9]{64}$/.test(name));
}
async function putBlob(directory, digest, bytes) {
  if (!SHA.test(digest) || bytes.length > MAX_ARTIFACT_BYTES || hash(bytes) !== digest) throw new Error('Artifact bytes do not match their digest');
  await privateDirectory(directory);
  const file = path.join(directory, `sha256-${digest}`);
  let existing;
  try { existing = await boundedRead(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) { if (!existing.equals(bytes)) throw new Error('Published artifact was modified'); return; }
  const names = await blobNames(directory);
  const sizes = await Promise.all(names.map(async name => (await lstat(path.join(directory, name))).size));
  if (names.length >= MAX_ARTIFACT_COUNT || sizes.reduce((sum, size) => sum + size, 0) + bytes.length > MAX_ARTIFACT_TOTAL_BYTES) throw new Error('Artifact collection exceeds 64 files or 2 MiB; publish focused deliverables');
  const handle = await open(file, 'wx', 0o400);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

/** Immutable controller-owned bytes; a filename in a private VM is never a handoff. */
export class AgentArtifactStore {
  constructor({ stateDirectory, swarmId }) { this.directory = path.join(stateDirectory, 'artifacts'); this.swarmId = swarmId; }
  buildCaptureTask(action, agent, context) { return buildCaptureTask(action, agent, context); }
  async list() {
    try {
      const index = JSON.parse(await boundedRead(path.join(this.directory, 'index.json'), MAX_ARTIFACT_INDEX_BYTES));
      if (index.schema !== 'ovm.artifacts/v1' || !Array.isArray(index.artifacts) || index.artifacts.length > MAX_ARTIFACT_PUBLICATIONS) throw new Error('Invalid artifact index');
      return index.artifacts;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async acceptCapture(task, worker) {
    const publication = task.artifactPublication;
    if (!publication || worker.agent !== task.agentId || worker.stopped !== true || worker.error || worker.exitCode !== 0) throw new Error(`Artifact publication failed: ${worker.error || worker.output || 'capture did not complete'}`.slice(0, 2048));
    const matches = String(worker.output ?? '').split(/\r?\n/).filter(line => line.startsWith(publication.token));
    if (matches.length !== 1) throw new Error('Artifact capture returned no unique complete receipt');
    const capture = JSON.parse(matches[0].slice(publication.token.length));
    if (capture.schema !== 'ovm.artifact-capture/v1' || !SHA.test(capture.sha256 ?? '') || !Number.isInteger(capture.bytes) || capture.bytes < 0 || capture.bytes > MAX_ARTIFACT_BYTES || typeof capture.base64 !== 'string' || capture.base64.length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4) throw new Error('Invalid artifact capture receipt');
    const bytes = Buffer.from(capture.base64, 'base64');
    if (bytes.toString('base64') !== capture.base64 || bytes.length !== capture.bytes) throw new Error('Artifact capture is truncated or malformed');
    const receipt = { schema: 'ovm.artifact/v1', id: `sha256:${capture.sha256}`, sha256: capture.sha256, bytes: bytes.length,
      name: publication.name, producer: publication.producer, swarmId: this.swarmId, round: publication.round,
      sourcePath: publication.sourcePath, guestPath: `/ovm/artifacts/sha256-${capture.sha256}`,
      environment: { pocket: task.agentId, machine: worker.placement?.machine ?? 'local', dispatchId: worker.placement?.dispatchId ?? null },
      claimStatus: 'captured-bytes', semanticVerification: false };
    const artifacts = await this.list();
    if (!artifacts.some(item => item.sha256 === receipt.sha256 && item.producer === receipt.producer && item.round === receipt.round && item.name === receipt.name)) artifacts.push(receipt);
    const serialized = serializeIndex(artifacts);
    await putBlob(this.directory, capture.sha256, bytes);
    const temporary = path.join(this.directory, `.index-${randomUUID()}.json`);
    await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path.join(this.directory, 'index.json'));
    return receipt;
  }
  async publishOstadix(task, execution, { evidenceId, instanceId }) {
    const program = task.ostadix;
    if (!program || program.mode !== 'run' || execution?.mode !== 'run' || execution.success !== true || execution.executed !== true || execution.checkStatus !== 'checks-passed') throw new Error('OSTADIX publication requires an executed program with passing checks');
    const action = normalizeOstadixAction({ type: 'ostadix', source: program.source, name: program.name, mode: 'run', checks: program.checks });
    const bytes = Buffer.from(action.source, 'utf8'), digest = hash(bytes);
    if (bytes.toString('utf8') !== action.source || program.sourceSha256 !== digest || execution.sourceSha256 !== digest) throw new Error('OSTADIX publication source digest mismatch');
    if (!Array.isArray(execution.checks) || execution.checks.length !== action.checks.length || !execution.checks.every((check, index) => check.passed === true && check.kind === action.checks[index].kind && check.expected === action.checks[index].expected)) throw new Error('OSTADIX execution checks do not match the publication contract');
    identityText(task.agentId, 'producer'); identityText(evidenceId, 'execution evidence ID'); identityText(instanceId, 'instance ID');
    if (!Number.isSafeInteger(program.round) || program.round < 0) throw new Error('Invalid OSTADIX artifact round');
    const receipt = { schema: 'ovm.artifact/v1', kind: 'ostadix-program', sha256: digest, bytes: bytes.length,
      name: action.name, producer: task.agentId, swarmId: this.swarmId ?? null, round: program.round,
      sourcePath: null, guestPath: `/ovm/artifacts/sha256-${digest}`,
      code: { language: 'ostadix', sourceSha256: digest, contract: { checks: action.checks },
        executionEvidenceId: evidenceId, producerInstanceId: instanceId, createdRound: program.round },
      claimStatus: 'awaiting-peer-review', semanticVerification: false };
    receipt.id = `ostadix:${ostadixIdentity(receipt)}`;
    const artifacts = await this.list();
    if (artifacts.some(item => item.id === receipt.id)) return (await this.readOstadixArtifact(receipt.id)).artifact;
    artifacts.push(receipt);
    const serialized = serializeIndex(artifacts);
    await putBlob(this.directory, digest, bytes);
    const temporary = path.join(this.directory, `.index-${randomUUID()}.json`);
    await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path.join(this.directory, 'index.json'));
    return receipt;
  }
  async readOstadixArtifact(artifactId) {
    if (typeof artifactId !== 'string' || !OSTADIX_ID.test(artifactId)) throw new Error('Invalid OSTADIX artifact ID');
    const matches = (await this.list()).filter(item => item.id === artifactId);
    if (matches.length !== 1) throw new Error('OSTADIX artifact must resolve to one unique publication');
    const artifact = matches[0], code = artifact.code;
    if (artifact.schema !== 'ovm.artifact/v1' || artifact.kind !== 'ostadix-program' || !SHA.test(artifact.sha256 ?? '') || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.guestPath !== `/ovm/artifacts/sha256-${artifact.sha256}` || code?.language !== 'ostadix' || code.sourceSha256 !== artifact.sha256 || code.createdRound !== artifact.round || !Number.isSafeInteger(artifact.round) || artifact.round < 0 || artifact.claimStatus !== 'awaiting-peer-review' || artifact.semanticVerification !== false) throw new Error('Invalid OSTADIX artifact receipt');
    identityText(artifact.producer, 'producer'); identityText(code.executionEvidenceId, 'execution evidence ID'); identityText(code.producerInstanceId, 'instance ID');
    const bytes = await boundedRead(path.join(this.directory, `sha256-${artifact.sha256}`));
    if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) throw new Error('OSTADIX artifact bytes do not match their digest');
    const source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) throw new Error('OSTADIX artifact source is not exact UTF-8');
    const action = normalizeOstadixAction({ type: 'ostadix', source, name: artifact.name, mode: 'run', checks: code.contract?.checks });
    if (action.name !== artifact.name || JSON.stringify(action.checks) !== JSON.stringify(code.contract?.checks) || artifact.id !== `ostadix:${ostadixIdentity(artifact)}`) throw new Error('OSTADIX artifact contract identity mismatch');
    return { artifact, source, action };
  }
}

export async function artifactInputs(directory) {
  const inputs = [];
  let total = 0;
  for (const name of await blobNames(directory)) {
    const bytes = await boundedRead(path.join(directory, name));
    const digest = name.slice(7);
    if (hash(bytes) !== digest) throw new Error('Published artifact digest changed');
    total += bytes.length;
    if (total > MAX_ARTIFACT_TOTAL_BYTES || inputs.length >= MAX_ARTIFACT_COUNT) throw new Error('Artifact transfer budget exceeded');
    inputs.push({ digest, base64: bytes.toString('base64') });
  }
  return inputs;
}

export async function installArtifactInputs(directory, inputs = []) {
  if (!Array.isArray(inputs) || inputs.length > MAX_ARTIFACT_COUNT) throw new Error('Invalid artifact transfer');
  let total = 0;
  const seen = new Set(), verified = [];
  for (const item of inputs) {
    if (!SHA.test(item?.digest ?? '') || seen.has(item.digest) || typeof item.base64 !== 'string' || item.base64.length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4) throw new Error('Invalid artifact input');
    const bytes = Buffer.from(item.base64, 'base64');
    if (bytes.toString('base64') !== item.base64 || hash(bytes) !== item.digest || bytes.length > MAX_ARTIFACT_BYTES) throw new Error('Artifact input digest mismatch');
    total += bytes.length;
    if (total > MAX_ARTIFACT_TOTAL_BYTES) throw new Error('Artifact transfer exceeds 2 MiB');
    seen.add(item.digest); verified.push([item.digest, bytes]);
  }
  for (const [digest, bytes] of verified) await putBlob(directory, digest, bytes);
}
