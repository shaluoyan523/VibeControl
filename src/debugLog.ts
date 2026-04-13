import * as fs from 'fs';

const DEBUG_LOG_PATH = '/tmp/vibe-control-debug.log';

export function getDebugLogPath(): string {
  return DEBUG_LOG_PATH;
}

export function logDebug(message: string): void {
  const timestamp = new Date().toISOString();
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, `[${timestamp}] ${message}\n`, 'utf8');
  } catch {
    // Best-effort debug logging only.
  }
}
