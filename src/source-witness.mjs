import { randomUUID } from 'node:crypto';
import { shellQuote } from './controller-transport.mjs';

export function normalizeSource(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Use --source guest:/absolute/path');
  const raw = value.startsWith('guest:') ? value.slice(6) : value;
  if (!raw.startsWith('/') || raw.includes('\0') || raw.length > 2048) throw new Error('Source must be an absolute guest path, for example guest:/root/.bash_history. Host history requires an explicit host-file handoff.');
  return { scope: 'guest', path: raw, origin: 'user-selected', status: 'uninspected' };
}

export function buildSourceTask(action, agent, { round, swarmId = null, instanceId = null }) {
  const source = normalizeSource(action.path);
  const token = `OVM_SOURCE_${randomUUID().replaceAll('-', '')}`;
  const script = `import os,stat,json,hashlib\np=${JSON.stringify(source.path)}\nr={"schema":"ovm.source-capture/v1","path":p}\nf=None\ntry:\n try: f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)\n except FileNotFoundError: r["kind"]="source_absent"\n except OSError as e: r.update(kind="source_unreadable",error=str(e))\n if f is not None:\n  before=os.fstat(f)\n  if not stat.S_ISREG(before.st_mode): r["kind"]="source_not_regular"\n  else:\n   r.update(kind="source_present",bytes=before.st_size,sha256=None)\n   if before.st_size<=16777216:\n    h=hashlib.sha256()\n    while True:\n     b=os.read(f,1048576)\n     if not b: break\n     h.update(b)\n    after=os.fstat(f)\n    if (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns): r.update(kind="source_unreadable",error="source changed during inspection")\n    else: r["sha256"]=h.hexdigest()\n   else: r["digestOmittedReason"]="source exceeds 16 MiB inspection budget"\nfinally:\n if f is not None: os.close(f)\nprint(${JSON.stringify(token)}+json.dumps(r))\n`;
  return { agentId: agent.id, command: `python3 -c ${shellQuote(script)}`, sourceInspection: { ...source, token, producer: agent.id, round, swarmId, instanceId } };
}

export function acceptSourceCapture(task, worker) {
  const inspection = task.sourceInspection;
  if (!inspection || worker.agent !== task.agentId || worker.stopped !== true || worker.exitCode !== 0 || worker.error) throw new Error('Source inspection did not return a successful stopped-VM receipt');
  const records = String(worker.output ?? '').split(/\r?\n/).filter(line => line.startsWith(inspection.token));
  if (records.length !== 1) throw new Error('No unique structured source witness was returned');
  const value = JSON.parse(records[0].slice(inspection.token.length));
  if (value.schema !== 'ovm.source-capture/v1' || value.path !== inspection.path || !['source_present','source_absent','source_unreadable','source_not_regular'].includes(value.kind)) throw new Error('Invalid source witness');
  if (value.kind === 'source_present' && (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || (value.sha256 !== null && !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')))) throw new Error('Invalid source content identity');
  return { kind: value.kind, scope: 'guest', path: inspection.path, producer: inspection.producer, round: inspection.round,
    ...(value.kind === 'source_present' ? { bytes: value.bytes, sha256: value.sha256, ...(value.digestOmittedReason ? { digestOmittedReason: value.digestOmittedReason } : {}) } : {}),
    ...(value.error ? { error: String(value.error).slice(0, 1024) } : {}),
    environment: { pocket: task.agentId, swarmId: inspection.swarmId, instanceId: inspection.instanceId, machine: worker.placement?.machine ?? 'local', dispatchId: worker.placement?.dispatchId ?? null },
    meaning: 'Observation of this path in this VM at this round; it does not establish contents or absence on another machine', semanticVerification: false };
}
