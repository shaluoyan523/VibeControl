import * as path from 'path';
import { HttpServer } from '../httpServer';
import { ProcessManager } from '../processManager';
import { CodexProcessManager } from '../codexProcessManager';
import { clearDaemonState, getDaemonScriptIdentity, writeDaemonState } from './common';
import { HeadlessConversationRegistry } from './headlessConversationRegistry';
import { HeadlessClaudeProvider } from './headlessClaudeProvider';
import { HeadlessCodexProvider } from './headlessCodexProvider';
import { SessionHandoffService } from '../sessionHandoffService';
import { SessionHandoffQueueProcessor } from '../sessionHandoffQueue';
import { ensureSessionHandoffTooling } from '../sessionTooling';

async function main(): Promise<void> {
  const extensionRoot = path.resolve(__dirname, '..');
  const port = readPortArg(process.argv.slice(2)) ?? 23816;
  const version = readVersionArg(process.argv.slice(2)) ?? 'dev';
  const daemonScriptIdentity = getDaemonScriptIdentity(__filename);
  ensureSessionHandoffTooling(process.execPath);

  const claudeProcessManager = new ProcessManager(extensionRoot);
  const codexProcessManager = new CodexProcessManager();
  const registry = new HeadlessConversationRegistry([
    new HeadlessClaudeProvider(extensionRoot, claudeProcessManager),
    new HeadlessCodexProvider(),
  ]);
  const sessionHandoffService = new SessionHandoffService(
    registry,
    claudeProcessManager,
    codexProcessManager,
  );
  const handoffQueue = new SessionHandoffQueueProcessor(sessionHandoffService);
  const server = new HttpServer(
    registry,
    claudeProcessManager,
    codexProcessManager,
    port,
    {
      mode: 'daemon',
      scriptFingerprint: daemonScriptIdentity.scriptFingerprint,
      scriptPath: daemonScriptIdentity.scriptPath,
      version,
    },
  );
  handoffQueue.start();

  const actualPort = await server.start();
  writeDaemonState({
    pid: process.pid,
    port: actualPort,
    version,
    startedAt: Date.now(),
    scriptFingerprint: daemonScriptIdentity.scriptFingerprint,
    scriptPath: daemonScriptIdentity.scriptPath,
  });

  const shutdown = async () => {
    await server.stop();
    handoffQueue.dispose();
    claudeProcessManager.dispose();
    codexProcessManager.dispose();
    clearDaemonState();
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('exit', () => {
    clearDaemonState();
  });
}

void main().catch(async (error) => {
  console.error('Vibe Control daemon failed to start:', error);
  clearDaemonState();
  process.exit(1);
});

function readPortArg(args: string[]): number | null {
  const index = args.indexOf('--port');
  if (index === -1) { return null; }
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : null;
}

function readVersionArg(args: string[]): string | null {
  const index = args.indexOf('--version');
  if (index === -1) { return null; }
  const value = args[index + 1];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
