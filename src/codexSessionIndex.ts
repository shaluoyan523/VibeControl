import * as fs from 'fs';
import * as path from 'path';
import { ConversationRecord } from './types';

export interface CodexSessionSnapshot {
  filePath: string;
  mtimeMs: number;
  size: number;
}

interface CachedCodexSessionEntry<T extends { id: string }> extends CodexSessionSnapshot {
  record: T;
}

const DEFAULT_PREVIEW_BYTES = 256 * 1024;

export class CodexSessionIndex<T extends { id: string }> {
  private entriesByFile = new Map<string, CachedCodexSessionEntry<T>>();
  private filesById = new Map<string, string>();
  private knownFiles: string[] = [];

  reconcile(
    snapshots: CodexSessionSnapshot[],
    readRecord: (snapshot: CodexSessionSnapshot) => T | null,
  ): T[] {
    const nextEntries = new Map<string, CachedCodexSessionEntry<T>>();
    const nextFilesById = new Map<string, string>();
    const nextKnownFiles = snapshots.map(snapshot => snapshot.filePath);
    const records: T[] = [];

    for (const snapshot of snapshots) {
      const cached = this.entriesByFile.get(snapshot.filePath);
      const record = cached
        && cached.mtimeMs === snapshot.mtimeMs
        && cached.size === snapshot.size
        ? cached.record
        : readRecord(snapshot);

      if (!record) {
        continue;
      }

      nextEntries.set(snapshot.filePath, { ...snapshot, record });
      nextFilesById.set(record.id, snapshot.filePath);
      records.push(record);
    }

    this.entriesByFile = nextEntries;
    this.filesById = nextFilesById;
    this.knownFiles = nextKnownFiles;
    return records;
  }

  findFilePath(id: string): string | null {
    return this.filesById.get(id)
      || this.knownFiles.find(filePath => filePath.includes(id))
      || null;
  }

  invalidate(filePath?: string): void {
    if (!filePath) {
      this.entriesByFile.clear();
      this.filesById.clear();
      this.knownFiles = [];
      return;
    }

    this.entriesByFile.delete(filePath);
    for (const [id, knownFilePath] of this.filesById.entries()) {
      if (knownFilePath === filePath) {
        this.filesById.delete(id);
      }
    }
  }
}

export function collectCodexSessionSnapshots(dir: string): CodexSessionSnapshot[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const snapshots: CodexSessionSnapshot[] = [];
  collectSnapshotsRecursive(dir, snapshots);
  return snapshots;
}

export function readCodexSessionPreview(
  snapshot: CodexSessionSnapshot,
  normalizeProjectPath: (projectPath?: string) => string | undefined,
): ConversationRecord | null {
  try {
    const preview = readFilePrefix(snapshot.filePath, snapshot.size);
    const firstLine = preview.split('\n').find(line => line.trim());
    if (!firstLine) {
      return null;
    }

    const first = JSON.parse(firstLine);
    const payload = first?.payload || {};
    const sessionId = payload.id;
    if (!sessionId) {
      return null;
    }

    const firstPrompt = extractFirstPrompt(preview) || undefined;
    const summary = firstPrompt || sessionId;

    return {
      provider: 'codex',
      id: sessionId,
      name: summary,
      summary,
      lastModified: snapshot.mtimeMs,
      fileSize: snapshot.size,
      cwd: normalizeProjectPath(payload.cwd),
      firstPrompt,
      status: 'not_started',
    };
  } catch {
    return null;
  }
}

export function readCodexSessionMetadata(
  filePath: string,
): { source: string | null; originator: string | null } | null {
  try {
    const preview = readFilePrefix(filePath);
    const firstLine = preview.split('\n').find(line => line.trim());
    if (!firstLine) {
      return null;
    }

    const first = JSON.parse(firstLine);
    return {
      source: typeof first?.payload?.source === 'string' ? first.payload.source : null,
      originator: typeof first?.payload?.originator === 'string' ? first.payload.originator : null,
    };
  } catch {
    return null;
  }
}

function collectSnapshotsRecursive(dir: string, snapshots: CodexSessionSnapshot[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSnapshotsRecursive(fullPath, snapshots);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    try {
      const stat = fs.statSync(fullPath);
      snapshots.push({
        filePath: fullPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } catch {
      // Ignore files that disappear while scanning.
    }
  }
}

function readFilePrefix(filePath: string, sizeHint?: number, maxBytes = DEFAULT_PREVIEW_BYTES): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = typeof sizeHint === 'number' ? sizeHint : fs.statSync(filePath).size;
    const length = Math.max(1, Math.min(size, maxBytes));
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function extractFirstPrompt(content: string): string | null {
  const match = content.match(/"text"\s*:\s*"([^"]{1,100})/);
  if (!match) {
    return null;
  }
  return match[1].length >= 100 ? `${match[1]}...` : match[1];
}
