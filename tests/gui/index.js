const path = require('node:path');
const Mocha = require('mocha');

async function run() {
  const mocha = new Mocha({
    color: true,
    timeout: 120_000,
    ui: 'tdd',
  });

  mocha.addFile(path.resolve(__dirname, 'smoke.test.js'));

  await new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} GUI test(s) failed.`));
        return;
      }

      resolve();
    });
  });
}

module.exports = {
  run,
};
