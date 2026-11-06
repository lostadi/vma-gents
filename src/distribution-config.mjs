import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateControllerNodePath } from './controller-transport.mjs';

export const DISTRIBUTION_MODES = ['auto', 'local', 'required'];
export function distributionDirectory(projectRoot, environment = process.env) {
  return path.resolve(environment.OVM_DISTRIBUTION_STATE || path.join(projectRoot, 'runtime/distribution'));
}
export function validateDistributionMode(mode) {
  if (!DISTRIBUTION_MODES.includes(mode)) throw new Error('Distribution mode must be auto, local, or required.');
  return mode;
}
function validatePeerInterpreters(peers) {
  if (!Array.isArray(peers)) throw new Error('Invalid OVM distribution peers.');
  for (const peer of peers) if (peer?.nodePath !== undefined) validateControllerNodePath(peer.nodePath);
}
export function readDistributionSettings(projectRoot, environment = process.env) {
  let settings = { version: 1, mode: 'auto', peers: [] };
  try { settings = { ...settings, ...JSON.parse(readFileSync(path.join(distributionDirectory(projectRoot, environment), 'config.json'), 'utf8')) }; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read OVM distribution settings: ${error.message}`); }
  if (settings.version !== 1 || !Array.isArray(settings.peers)) throw new Error('Invalid OVM distribution settings.');
  validatePeerInterpreters(settings.peers);
  settings.mode = validateDistributionMode(environment.OVM_DISTRIBUTION_MODE || settings.mode);
  if (settings.networkState && !path.isAbsolute(settings.networkState)) throw new Error('Saved network state must be an absolute path.');
  return settings;
}
export async function saveDistributionSettings(projectRoot, settings, environment = process.env) {
  validateDistributionMode(settings.mode);
  validatePeerInterpreters(settings.peers);
  const directory = distributionDirectory(projectRoot, environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.config-${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify({ ...settings, version: 1 }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path.join(directory, 'config.json'));
  return settings;
}
export function applyDistributionEnvironment(projectRoot, environment = process.env) {
  const settings = readDistributionSettings(projectRoot, environment);
  environment.OVM_DISTRIBUTION_MODE ??= settings.mode;
  if (settings.networkState) environment.OVM_NETWORK_STATE ??= settings.networkState;
  return settings;
}
