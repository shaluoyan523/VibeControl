import * as fs from 'fs';
import * as path from 'path';
import {
  getVibeControlHandoffBinPath,
  getVibeControlHandoffScriptPath,
  getVibeControlPortFilePath,
  getVibeControlToolsDir,
} from './runtimePaths';
import { ProviderId } from './types';

export function ensureSessionHandoffTooling(nodeExecutable = process.execPath): string {
  const toolsDir = getVibeControlToolsDir();
  const scriptPath = getVibeControlHandoffScriptPath();
  const binPath = getVibeControlHandoffBinPath();

  fs.mkdirSync(toolsDir, { recursive: true });
  writeFileIfChanged(scriptPath, buildNodeScript());

  if (process.platform === 'win32') {
    writeFileIfChanged(binPath, buildWindowsWrapper(nodeExecutable, scriptPath));
  } else {
    writeFileIfChanged(binPath, buildPosixWrapper(nodeExecutable, scriptPath));
    try {
      fs.chmodSync(binPath, 0o755);
      fs.chmodSync(scriptPath, 0o755);
    } catch {
      // Best-effort only.
    }
  }

  return binPath;
}

export function buildSessionToolEnvironment(input: {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  nodeExecutable?: string;
}): NodeJS.ProcessEnv {
  const handoffBin = ensureSessionHandoffTooling(input.nodeExecutable || process.execPath);
  return {
    VIBE_CONTROL_PROVIDER: input.provider,
    VIBE_CONTROL_SESSION_ID: input.sessionId,
    VIBE_CONTROL_SESSION_CWD: input.cwd,
    VIBE_CONTROL_PORT_FILE: getVibeControlPortFilePath(),
    VIBE_CONTROL_HANDOFF_BIN: handoffBin,
  };
}

function writeFileIfChanged(filePath: string, nextContent: string): void {
  try {
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
    if (existing === nextContent) {
      return;
    }
    fs.writeFileSync(filePath, nextContent, 'utf-8');
  } catch {
    // Best-effort only.
  }
}

function buildPosixWrapper(nodeExecutable: string, scriptPath: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
exec "${escapeDoubleQuoted(nodeExecutable)}" "${escapeDoubleQuoted(scriptPath)}" "$@"
`;
}

function buildWindowsWrapper(nodeExecutable: string, scriptPath: string): string {
  return `@echo off\r\n"${nodeExecutable}" "${scriptPath}" %*\r\n`;
}

function buildNodeScript(): string {
  const defaultPortFile = getVibeControlPortFilePath();
  return `#!/usr/bin/env node
import fs from 'fs';
import http from 'http';
import path from 'path';

const args = process.argv.slice(2);
const options = parseArgs(args);

if (options.help) {
  printHelp();
  process.exit(0);
}

const sourceProvider = options.sourceProvider || process.env.VIBE_CONTROL_PROVIDER || '';
const sourceSessionId = options.sourceSessionId || process.env.VIBE_CONTROL_SESSION_ID || '';
if (!sourceProvider || !sourceSessionId) {
  console.error('Vibe Control handoff: source provider/session could not be inferred. Pass --source-provider and --source-session, or run inside a Vibe Control managed session.');
  process.exit(1);
}

const portFilePath = process.env.VIBE_CONTROL_PORT_FILE || ${JSON.stringify(defaultPortFile)};
const payload = {
  provider: sourceProvider,
};
if (options.targetProvider) payload.targetProvider = options.targetProvider;
if (options.targetSessionId) payload.targetSessionId = options.targetSessionId;
if (options.title) payload.title = options.title;
if (options.instructions) payload.instructions = options.instructions;
if (options.artifactKind) payload.artifactKind = options.artifactKind;
if (options.basePath) payload.basePath = options.basePath;
if (options.relayToTarget) payload.relayToTarget = true;

const port = readPort(portFilePath);
if (port) {
  tryHttp(port, sourceSessionId, payload).catch(async (error) => {
    try {
      const fallback = await tryQueueFallback(portFilePath, payload);
      process.stdout.write(JSON.stringify(fallback) + '\\n');
    } catch (queueError) {
      const queueMessage = queueError instanceof Error ? queueError.message : String(queueError);
      const httpMessage = error instanceof Error ? error.message : String(error);
      console.error('Vibe Control handoff request failed: ' + httpMessage + '; queue fallback failed: ' + queueMessage);
      process.exit(1);
    }
  });
} else {
  tryQueueFallback(portFilePath, payload)
    .then((result) => {
      process.stdout.write(JSON.stringify(result) + '\\n');
    })
    .catch((error) => {
      console.error('Vibe Control handoff: could not read the local API port file at ' + portFilePath + '; queue fallback failed: ' + (error instanceof Error ? error.message : String(error)));
      process.exit(1);
    });
}

function parseArgs(rawArgs) {
  const parsed = {
    relayToTarget: false,
    help: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const current = rawArgs[index];
    switch (current) {
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--source-provider':
        parsed.sourceProvider = rawArgs[++index] || '';
        break;
      case '--source-session':
        parsed.sourceSessionId = rawArgs[++index] || '';
        break;
      case '--target-provider':
        parsed.targetProvider = rawArgs[++index] || '';
        break;
      case '--target-session':
        parsed.targetSessionId = rawArgs[++index] || '';
        break;
      case '--title':
        parsed.title = rawArgs[++index] || '';
        break;
      case '--instructions':
        parsed.instructions = rawArgs[++index] || '';
        break;
      case '--artifact-kind':
        parsed.artifactKind = rawArgs[++index] || '';
        break;
      case '--base-path':
        parsed.basePath = rawArgs[++index] || '';
        break;
      case '--relay':
        parsed.relayToTarget = true;
        break;
      default:
        break;
    }
  }

  return parsed;
}

function readPort(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    const port = Number(raw);
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

function tryHttp(port, sourceSessionId, payload) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/conversations/' + encodeURIComponent(sourceSessionId) + '/handoff',
      headers: {
        'Content-Type': 'application/json',
      },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        const normalized = body.trim();
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(normalized || ('HTTP ' + response.statusCode)));
          return;
        }
        try {
          resolve(JSON.parse(normalized));
        } catch {
          resolve(normalized);
        }
      });
    });

    request.on('error', reject);
    request.end(JSON.stringify(payload));
  }).then((result) => {
    process.stdout.write((typeof result === 'string' ? result : JSON.stringify(result)) + '\\n');
  });
}

async function tryQueueFallback(portFilePath, payload) {
  const queueDir = path.join(path.dirname(portFilePath), 'handoff-queue');
  fs.mkdirSync(queueDir, { recursive: true });

  const requestId = 'handoff-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const requestPath = path.join(queueDir, requestId + '.request.json');
  const resultPath = path.join(queueDir, requestId + '.result.json');
  const errorPath = path.join(queueDir, requestId + '.error.txt');

  fs.writeFileSync(requestPath, JSON.stringify({
    id: requestId,
    createdAt: new Date().toISOString(),
    input: {
      sourceProvider,
      sourceSessionId,
      ...payload,
    },
  }, null, 2), 'utf-8');

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
      cleanupQueueFiles([requestPath, resultPath, errorPath]);
      return result;
    }

    if (fs.existsSync(errorPath)) {
      const message = fs.readFileSync(errorPath, 'utf-8').trim() || 'Unknown queue error';
      cleanupQueueFiles([requestPath, resultPath, errorPath]);
      throw new Error(message);
    }

    await delay(250);
  }

  cleanupQueueFiles([requestPath, resultPath, errorPath]);
  throw new Error('Timed out waiting for queue fallback');
}

function cleanupQueueFiles(filePaths) {
  for (const filePath of filePaths) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  process.stdout.write([
    'Usage: vibe-control-handoff [options]',
    '',
    'Defaults --source-provider and --source-session from VIBE_CONTROL_* env vars when run inside a managed session.',
    'If localhost access is blocked, it falls back to a filesystem queue beside the Vibe Control port file.',
    '',
    'Options:',
    '  --target-provider <claude|codex>',
    '  --target-session <id>',
    '  --title <title>',
    '  --instructions <text>',
    '  --artifact-kind <task-draft|note>',
    '  --base-path <path>',
    '  --relay',
    '  --help',
    '',
  ].join('\\n'));
}
`;
}

function escapeDoubleQuoted(value: string): string {
  return value.replace(/(["\\\\$`])/g, '\\\\$1');
}
