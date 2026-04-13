import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let cachedExecutable: string | null | undefined;

export function resolveCodexExecutable(): string {
  if (cachedExecutable !== undefined) {
    return cachedExecutable || 'codex';
  }

  for (const candidate of collectCandidates()) {
    if (isExecutable(candidate)) {
      cachedExecutable = candidate;
      return candidate;
    }
  }

  cachedExecutable = null;
  return 'codex';
}

function collectCandidates(): string[] {
  const home = os.homedir();
  const candidates = new Set<string>();

  const envPath = process.env.PATH || '';
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    candidates.add(path.join(dir, executableName()));
  }

  candidates.add(path.join(home, '.local', 'bin', executableName()));
  candidates.add(path.join('/usr/local/bin', executableName()));
  candidates.add(path.join('/usr/bin', executableName()));

  for (const extensionDir of listOpenAiExtensionDirs(path.join(home, '.windsurf-server', 'extensions'))) {
    candidates.add(path.join(extensionDir, 'bin', platformBinaryDir(), executableName()));
  }

  for (const npmDir of listNodeCodexBins(path.join(home, '.nvm', 'versions', 'node'))) {
    candidates.add(npmDir);
  }

  return Array.from(candidates);
}

function listOpenAiExtensionDirs(baseDir: string): string[] {
  try {
    return fs.readdirSync(baseDir)
      .filter(name => name.startsWith('openai.chatgpt-'))
      .sort()
      .reverse()
      .map(name => path.join(baseDir, name));
  } catch {
    return [];
  }
}

function listNodeCodexBins(nodeVersionsDir: string): string[] {
  const candidates: string[] = [];

  try {
    const versionDirs = fs.readdirSync(nodeVersionsDir)
      .map(name => path.join(nodeVersionsDir, name))
      .filter(fullPath => safeIsDirectory(fullPath));

    for (const versionDir of versionDirs) {
      const vendorDir = path.join(
        versionDir,
        'lib',
        'node_modules',
        '@openai',
        'codex',
        'node_modules',
        npmPlatformPackage(),
        'vendor',
        npmVendorSubdir(),
        'codex',
        executableName(),
      );
      candidates.push(vendorDir);
    }
  } catch {
    return [];
  }

  return candidates;
}

function executableName(): string {
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

function platformBinaryDir(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64';
  }
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'win32-arm64' : 'win32-x86_64';
  }
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x86_64';
}

function npmPlatformPackage(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? '@openai/codex-darwin-arm64' : '@openai/codex-darwin-x64';
  }
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? '@openai/codex-windows-arm64' : '@openai/codex-windows-x64';
  }
  return process.arch === 'arm64' ? '@openai/codex-linux-arm64' : '@openai/codex-linux-x64';
}

function npmVendorSubdir(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  }
  return process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl';
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function safeIsDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
