import * as child_process from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import {
  clearDaemonState,
  getDaemonPortFilePath,
  getDaemonScriptIdentity,
  getDaemonScriptPath,
  readDaemonState,
} from './common';
import { getClaudeConfigDir } from '../runtimePaths';

type ExpectedDaemonIdentity = {
  scriptFingerprint: string;
  scriptPath: string;
  version: string;
};

type DaemonHealth = {
  ok: boolean;
  scriptFingerprint?: string;
  scriptPath?: string;
  version?: string;
};

export async function ensureDaemonRunning(params: {
  extensionRoot: string;
  port: number;
  version: string;
}): Promise<number | null> {
  const expectedIdentity: ExpectedDaemonIdentity = {
    ...getDaemonScriptIdentity(getDaemonScriptPath(params.extensionRoot)),
    version: params.version,
  };
  const existing = await detectRunningDaemon(expectedIdentity);
  if (existing) {
    return existing;
  }

  await stopStaleDaemon(expectedIdentity);
  await spawnDaemon(params);
  return await waitForDaemon(expectedIdentity, 10000);
}

async function detectRunningDaemon(expectedIdentity: ExpectedDaemonIdentity): Promise<number | null> {
  const candidates = new Set<number>();
  const state = readDaemonState();
  if (state?.port) {
    candidates.add(state.port);
  }
  const portFilePath = getDaemonPortFilePath();
  if (fs.existsSync(portFilePath)) {
    const parsed = Number(fs.readFileSync(portFilePath, 'utf-8').trim());
    if (Number.isFinite(parsed)) {
      candidates.add(parsed);
    }
  }

  for (const port of candidates) {
    const health = await probeDaemon(port);
    if (daemonMatches(health, expectedIdentity)) {
      return port;
    }
  }

  return null;
}

async function stopStaleDaemon(expectedIdentity: ExpectedDaemonIdentity): Promise<void> {
  const state = readDaemonState();
  if (!state?.pid || !state.port) {
    return;
  }

  const health = await probeDaemon(state.port);
  if (!health?.ok) {
    clearDaemonState();
    return;
  }
  if (daemonMatches(health, expectedIdentity)) {
    return;
  }

  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    clearDaemonState();
    return;
  }

  if (await waitForPortToClose(state.port, 3000)) {
    clearDaemonState();
    return;
  }

  try {
    process.kill(state.pid, 'SIGKILL');
  } catch {
    // Best-effort only.
  }

  await waitForPortToClose(state.port, 1500);
  clearDaemonState();
}

async function spawnDaemon(params: {
  extensionRoot: string;
  port: number;
  version: string;
}): Promise<void> {
  const daemonScript = path.join(params.extensionRoot, 'dist', 'daemon.js');
  const logPath = path.join(getClaudeConfigDir(), 'vibe-control-daemon.log');
  const logFd = fs.openSync(logPath, 'a');

  const child = child_process.spawn(process.execPath, [
    daemonScript,
    '--port',
    String(params.port),
    '--version',
    params.version,
  ], {
    cwd: params.extensionRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, VIBE_CONTROL_DAEMON: '1' },
  });

  child.unref();
}

async function waitForDaemon(expectedIdentity: ExpectedDaemonIdentity, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readDaemonState();
    if (state?.port) {
      const health = await probeDaemon(state.port);
      if (daemonMatches(health, expectedIdentity)) {
        return state.port;
      }
    }

    const portFilePath = getDaemonPortFilePath();
    if (fs.existsSync(portFilePath)) {
      const port = Number(fs.readFileSync(portFilePath, 'utf-8').trim());
      if (Number.isFinite(port)) {
        const health = await probeDaemon(port);
        if (daemonMatches(health, expectedIdentity)) {
          return port;
        }
      }
    }

    await delay(250);
  }

  return null;
}

async function probeDaemon(port: number): Promise<DaemonHealth | null> {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/healthz',
      method: 'GET',
      timeout: 1000,
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function daemonMatches(
  health: DaemonHealth | null,
  expectedIdentity: ExpectedDaemonIdentity,
): boolean {
  return !!health?.ok
    && health.version === expectedIdentity.version
    && health.scriptFingerprint === expectedIdentity.scriptFingerprint
    && normalizeScriptPath(health.scriptPath) === expectedIdentity.scriptPath;
}

async function waitForPortToClose(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeDaemon(port);
    if (!health?.ok) {
      return true;
    }
    await delay(100);
  }
  return false;
}

function normalizeScriptPath(scriptPath?: string): string | undefined {
  if (!scriptPath) {
    return undefined;
  }
  try {
    return fs.realpathSync(scriptPath);
  } catch {
    return path.resolve(scriptPath);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
