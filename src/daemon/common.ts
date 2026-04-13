import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getClaudeConfigDir } from '../runtimePaths';

export interface VibeControlDaemonState {
  pid: number;
  port: number;
  version: string;
  startedAt: number;
  scriptFingerprint?: string;
  scriptPath?: string;
}

export interface VibeControlDaemonScriptIdentity {
  scriptFingerprint: string;
  scriptPath: string;
}

export function getDaemonConfigDir(): string {
  return getClaudeConfigDir();
}

export function getDaemonPortFilePath(): string {
  return path.join(getDaemonConfigDir(), 'vibe-control-port');
}

export function getDaemonStateFilePath(): string {
  return path.join(getDaemonConfigDir(), 'vibe-control-daemon.json');
}

export function getDaemonScriptPath(extensionRoot: string): string {
  return path.join(extensionRoot, 'dist', 'daemon.js');
}

export function getDaemonScriptIdentity(scriptPath: string): VibeControlDaemonScriptIdentity {
  const resolvedScriptPath = fs.realpathSync(scriptPath);
  const scriptBuffer = fs.readFileSync(resolvedScriptPath);
  const scriptFingerprint = `sha256:${crypto.createHash('sha256').update(scriptBuffer).digest('hex')}`;
  return {
    scriptFingerprint,
    scriptPath: resolvedScriptPath,
  };
}

export function readDaemonState(): VibeControlDaemonState | null {
  try {
    const statePath = getDaemonStateFilePath();
    if (!fs.existsSync(statePath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (
      typeof parsed?.pid !== 'number'
      || typeof parsed?.port !== 'number'
      || typeof parsed?.version !== 'string'
      || typeof parsed?.startedAt !== 'number'
    ) {
      return null;
    }
    const state: VibeControlDaemonState = {
      pid: parsed.pid,
      port: parsed.port,
      version: parsed.version,
      startedAt: parsed.startedAt,
    };
    if (typeof parsed?.scriptFingerprint === 'string') {
      state.scriptFingerprint = parsed.scriptFingerprint;
    }
    if (typeof parsed?.scriptPath === 'string') {
      state.scriptPath = parsed.scriptPath;
    }
    return state;
  } catch {
    return null;
  }
}

export function writeDaemonState(state: VibeControlDaemonState): void {
  const configDir = getDaemonConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(getDaemonStateFilePath(), JSON.stringify(state, null, 2), 'utf-8');
}

export function clearDaemonState(): void {
  for (const filePath of [getDaemonStateFilePath(), getDaemonPortFilePath()]) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup only.
    }
  }
}
