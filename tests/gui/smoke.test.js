const assert = require('node:assert/strict');
const manifest = require('../../package.json');
const vscode = require('vscode');

async function waitForCommands(expectedCommands, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const commands = await vscode.commands.getCommands(true);
    if (expectedCommands.every((command) => commands.includes(command))) {
      return commands;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return vscode.commands.getCommands(true);
}

suite('Vibe Control GUI Smoke', () => {
  test('discovers the extension and registers core commands', async () => {
    const extensionId = `${manifest.publisher}.${manifest.name}`;
    const extension = vscode.extensions.getExtension(extensionId);

    assert.ok(
      extension,
      `Expected extension ${extensionId} to be available in the test host`,
    );

    const expectedCommands = [
      'vibe-control.newSession',
      'vibe-control.searchSessions',
      'vibe-control.searchWorkspace',
      'vibe-control.showSessionCenter',
    ];
    const commands = await waitForCommands(expectedCommands);

    for (const command of expectedCommands) {
      assert.ok(
        commands.includes(command),
        `Expected command ${command} to be registered`,
      );
    }
  });

  test('activates the extension when strict activation is enabled', async function () {
    if (process.env.VIBE_CONTROL_STRICT_ACTIVATION !== '1') {
      this.skip();
      return;
    }

    this.timeout(120_000);

    const extensionId = `${manifest.publisher}.${manifest.name}`;
    const extension = vscode.extensions.getExtension(extensionId);

    assert.ok(
      extension,
      `Expected extension ${extensionId} to be available in the test host`,
    );

    await extension.activate();
    assert.equal(extension.isActive, true);
  });
});
