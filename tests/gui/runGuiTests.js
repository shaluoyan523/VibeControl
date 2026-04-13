const fs = require('node:fs');
const path = require('node:path');
const {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
  runVSCodeCommand,
} = require('@vscode/test-electron');

const manifest = require('../../package.json');

function resolveVSCodeVersion() {
  const overrideVersion = process.env.VIBE_CONTROL_TEST_VSCODE_VERSION;
  if (overrideVersion) {
    return overrideVersion;
  }

  // Use the latest stable VS Code by default so extensionDependencies with
  // newer engine requirements can still be installed in the test host.
  return 'stable';
}

function resolveCachedVSCodeExecutable(version) {
  const cachedExecutablePath = path.resolve(
    __dirname,
    `../../.vscode-test/vscode-linux-x64-${version}/code`,
  );

  return fs.existsSync(cachedExecutablePath) ? cachedExecutablePath : null;
}

async function installExtensionDependencies(vscodeExecutablePath) {
  if (process.env.VIBE_CONTROL_SKIP_EXTENSION_DEPS === '1') {
    return;
  }

  const dependencies = Array.isArray(manifest.extensionDependencies)
    ? manifest.extensionDependencies
    : [];

  if (!dependencies.length) {
    return;
  }

  const cliArgs = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  for (const extensionId of dependencies) {
    console.log(`[gui-test] installing dependency extension ${extensionId}`);
    await runVSCodeCommand([...cliArgs, '--install-extension', extensionId], {
      reuseMachineInstall: false,
      spawn: {
        shell: process.platform === 'win32',
      },
    });
  }
}

async function main() {
  const version = resolveVSCodeVersion();
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'index.js');

  try {
    delete process.env.ELECTRON_RUN_AS_NODE;

    console.log(`[gui-test] using VS Code ${version}`);
    const cachedExecutablePath = resolveCachedVSCodeExecutable(version);
    const vscodeExecutablePath =
      cachedExecutablePath || (await downloadAndUnzipVSCode(version));

    if (cachedExecutablePath) {
      console.log(`[gui-test] reusing cached VS Code at ${cachedExecutablePath}`);
    }

    await installExtensionDependencies(vscodeExecutablePath);

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      reuseMachineInstall: false,
      extensionTestsEnv: {
        VSCODE_LOG_LEVEL: 'error',
      },
      launchArgs: [
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-telemetry',
        '--disable-updates',
        '--disable-gpu',
      ],
    });
  } catch (error) {
    console.error('[gui-test] failed to run extension GUI tests');
    console.error(error);
    process.exit(1);
  }
}

main();
