import * as os from 'os';
import * as path from 'path';

export function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function getClaudeProjectsDir(): string {
  return path.join(getClaudeConfigDir(), 'projects');
}

export function getCodexHomeDir(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function getCodexSessionsDir(): string {
  return path.join(getCodexHomeDir(), 'sessions');
}

export function getVibeControlPortFilePath(): string {
  return path.join(getClaudeConfigDir(), 'vibe-control-port');
}

export function getVibeControlToolsDir(): string {
  return path.join(getClaudeConfigDir(), 'tools');
}

export function getVibeControlHandoffScriptPath(): string {
  return path.join(getVibeControlToolsDir(), 'vibe-control-handoff.mjs');
}

export function getVibeControlHandoffBinPath(): string {
  return path.join(
    getVibeControlToolsDir(),
    process.platform === 'win32' ? 'vibe-control-handoff.cmd' : 'vibe-control-handoff',
  );
}

export function getVibeControlHandoffQueueDir(): string {
  return path.join(getClaudeConfigDir(), 'handoff-queue');
}
