import * as assert from 'node:assert/strict';
import { CodexSessionIndex } from '../src/codexSessionIndex';

type TestRecord = {
  id: string;
  name: string;
  lastModified: number;
};

function makeRecord(id: string, lastModified: number): TestRecord {
  return {
    id,
    name: `session-${id}`,
    lastModified,
  };
}

function run(): void {
  const index = new CodexSessionIndex<TestRecord>();
  const snapshots = [
    { filePath: '/tmp/a.jsonl', size: 10, mtimeMs: 100 },
    { filePath: '/tmp/b.jsonl', size: 20, mtimeMs: 200 },
  ];

  const records = new Map<string, TestRecord>([
    ['/tmp/a.jsonl', makeRecord('a', 100)],
    ['/tmp/b.jsonl', makeRecord('b', 200)],
    ['/tmp/c.jsonl', makeRecord('c', 300)],
  ]);

  let reads: string[] = [];
  let result = index.reconcile(snapshots, (snapshot) => {
    reads.push(snapshot.filePath);
    return records.get(snapshot.filePath) || null;
  });

  assert.deepEqual(reads, ['/tmp/a.jsonl', '/tmp/b.jsonl']);
  assert.equal(result.length, 2);
  assert.equal(index.findFilePath('a'), '/tmp/a.jsonl');
  assert.equal(index.findFilePath('missing'), null);

  reads = [];
  result = index.reconcile(snapshots, (snapshot) => {
    reads.push(snapshot.filePath);
    return records.get(snapshot.filePath) || null;
  });

  assert.deepEqual(reads, []);
  assert.equal(result.length, 2);

  reads = [];
  result = index.reconcile([
    { filePath: '/tmp/a.jsonl', size: 11, mtimeMs: 101 },
    snapshots[1],
    { filePath: '/tmp/c.jsonl', size: 30, mtimeMs: 300 },
  ], (snapshot) => {
    reads.push(snapshot.filePath);
    return records.get(snapshot.filePath) || null;
  });

  assert.deepEqual(reads, ['/tmp/a.jsonl', '/tmp/c.jsonl']);
  assert.equal(result.length, 3);
  assert.equal(index.findFilePath('c'), '/tmp/c.jsonl');

  reads = [];
  result = index.reconcile([
    { filePath: '/tmp/c.jsonl', size: 30, mtimeMs: 300 },
  ], (snapshot) => {
    reads.push(snapshot.filePath);
    return records.get(snapshot.filePath) || null;
  });

  assert.deepEqual(reads, []);
  assert.equal(result.length, 1);
  assert.equal(index.findFilePath('a'), null);
}

run();
