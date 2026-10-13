// Optional Playwright smoke test with simulated USB and serial devices.
// Usage: node firmware-dumper/tests/browser-smoke.cjs [playwright module path]
// Serve the workspace at http://127.0.0.1:8765 before running.
const {chromium} = require(process.argv[2] || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport: {width: 1200, height: 1000}});
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const requests = []; page.on('request', request => {
      if (request.url().startsWith('http')) requests.push(request.url());
    });
    await page.addInitScript({path: __dirname + '/fake-rp2040.js'});
    await page.addInitScript(() => {
      window.mockBridge = new FakeRP2040();
      Object.defineProperty(navigator, 'usb', {value: {requestDevice: async () => window.mockBridge}});
      Object.defineProperty(navigator, 'serial', {value: {requestPort: async () => window.mockBridge}});
    });
    await page.addInitScript(() => {
      // File system API emulator retains committed bytes for backup reread.
      window.savedRecovery = null;
      window.failBackupSave = false;
      window.showSaveFilePicker = async () => ({name: 'test-recovery-full.bin',
        createWritable: async () => ({write: async bytes => {
          if (window.failBackupSave) throw new Error('Injected disk write failure');
          window.pendingRecovery = Uint8Array.from(bytes);
        }, close: async () => { window.savedRecovery = window.pendingRecovery; }, abort: async () => {}}),
        getFile: async () => new File([window.savedRecovery], 'test-recovery-full.bin'),
      });
    });
    await page.goto(process.env.DUMPER_URL || 'http://127.0.0.1:8765/firmware-dumper/');
    assert(await page.locator('#verify').isChecked());
    assert(await page.locator('#dump').isDisabled());
    const uf2Download = page.waitForEvent('download');
    await page.locator('a[download="hanshow_pio_bridge.uf2"]').click();
    const uf2 = fs.readFileSync(await (await uf2Download).path());
    assert.deepEqual(uf2, fs.readFileSync(__dirname + '/../../dist/hanshow_pio_bridge.uf2'));
    await page.screenshot({path: '/tmp/firmware-dumper-desktop.png', fullPage: true});
    async function connect(baud) {
      await page.locator('#usb').click();
      assert.equal(await page.locator('#baud').inputValue(), '2000000');
      if (baud) await page.locator('#baud').selectOption(baud);
      await page.locator('#serial').click();
      assert(await page.locator('#baud').isDisabled());
      await page.locator('#activation').fill('100');
    }
    await connect(); await page.locator('#dump').click();
    await page.waitForFunction(() => !document.getElementById('result').hidden, {timeout: 30000});
    const binaryDownload = page.waitForEvent('download'); await page.locator('#binary').click();
    const binary = await binaryDownload; const data = fs.readFileSync(await binary.path());
    assert.equal(data.length, 524288);
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), '9aee50b8b6e9ee073b6053fd0262867baaf3b4176951cea7e93447500933e621');
    const reportDownload = page.waitForEvent('download'); await page.locator('#report').click();
    const report = await reportDownload; const metadata = JSON.parse(fs.readFileSync(await report.path()));
    assert.equal(metadata.sha256, crypto.createHash('sha256').update(data).digest('hex'));
    assert.equal(metadata.verification, 'two complete matching reads');
    assert.equal(metadata.baudRate, 2000000);
    assert.equal(metadata.divisor, 24);
    assert.equal(metadata.resetEchoVerified, true);
    assert(await page.locator('#dump').isDisabled()); // handles close after capture
    assert.match(await page.locator('#status').textContent(), /backup ready/);
    await page.screenshot({path: '/tmp/firmware-dumper-result.png', fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path: '/tmp/firmware-dumper-mobile.png', fullPage: true});

    // Reconnect with fresh streams, then force a verification mismatch.
    await page.evaluate(() => { window.mockBridge = new FakeRP2040(); window.mockBridge.corruptAtBlock = 182; window.mockBridge.corruptOffset = 0xabc; });
    await connect(); await page.locator('#dump').click();
    assert(await page.locator('#result').isHidden());
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Backup failed:'), {timeout: 30000});
    assert(await page.locator('#result').isHidden());
    assert.equal(await page.locator('#binary').getAttribute('href'), null);
    assert.match(await page.locator('#status').textContent(), /Verification mismatch at 0x035abc/);
    assert.match(await page.locator('#log').textContent(), /matches read 1. Backup remains rejected/);

    // Cancel during capture and verify a new complete-download link is absent.
    await page.evaluate(() => { window.mockBridge = new FakeRP2040(); window.mockBridge.stayBusy = true; });
    await connect('1500000'); await page.locator('#dump').click();
    await page.waitForFunction(() => window.mockBridge.blockRequests > 0);
    assert.equal(await page.evaluate(() => window.mockBridge.baudRate), 1500000);
    assert.equal(await page.evaluate(() => window.mockBridge.registers.get(0xb2)), 32);
    await page.locator('#cancel').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Cancelled.'));
    assert(await page.locator('#result').isHidden());
    assert.equal(await page.evaluate(() => window.mockBridge.cancelCount), 1);
    assert.equal(await page.evaluate(() => window.mockBridge.signals.at(-1).requestToSend), false);
    const {fixture} = require('./flash-fixture.cjs');
    const original = Uint8Array.from({length: 524288}, (_, i) => ((i >>> 8) ^ i ^ (i >>> 16)) & 255);
    const plan = await fixture(original);
    const files = [
      {name: 'flash-plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(plan.meta))},
      {name: 'application-padded.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(plan.application)},
      {name: 'expected-full-flash.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(plan.expected)},
      {name: 'recovery-application.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(plan.recovery)},
    ];
    await page.evaluate(() => { window.mockBridge = new FakeRP2040(); window.mockBridge.version = 0x10006; window.mockBridge.allowFlash = true; });
    await page.locator('#flash-files').setInputFiles(files);
    await page.waitForFunction(() => document.getElementById('plan-status').textContent.startsWith('Application plan validated'));
    await connect();
    assert(await page.locator('#flash').isDisabled());
    await page.locator('#flash-confirm').check();
    await page.locator('#flash').click();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Application installed and verified.', {timeout: 30000});
    assert.deepEqual(await page.evaluate(() => window.mockBridge.eraseOrder), [4096, 0]);
    assert.equal(await page.evaluate(() => window.mockBridge.protection), 0x382c);
    assert.equal(await page.evaluate(() => window.savedRecovery.length), 524288);
    const flashReportDownload = page.waitForEvent('download'); await page.locator('#flash-report').click();
    const flashReport = JSON.parse(fs.readFileSync(await (await flashReportDownload).path()));
    assert(flashReport.verified && flashReport.apply && flashReport.backupSaved && flashReport.cpuResetVerified);
    assert(await page.locator('#flash').isDisabled());
    await page.evaluate(() => { window.mockBridge = new FakeRP2040(); window.mockBridge.version = 0x10006; window.mockBridge.allowFlash = true; window.failBackupSave = true; });
    await connect(); await page.locator('#flash-confirm').check(); await page.locator('#flash').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Injected disk write failure'), {timeout: 30000});
    assert.deepEqual(await page.evaluate(() => window.mockBridge.eraseOrder), []);
    assert.deepEqual(await page.evaluate(() => window.mockBridge.statusWrites), []);
    assert.equal(await page.locator('#flash-files').isDisabled(), false);
    assert.equal(await page.locator('#flash-result').isHidden(), false);
    assert.deepEqual(errors, []);
    assert(requests.every(url => url === (process.env.DUMPER_URL || 'http://127.0.0.1:8765/firmware-dumper/')), 'Standalone page loaded another network resource');
    console.log('Browser checks passed: standalone page without other network resources, embedded UF2, complete downloads, hash/report, mismatch, cancellation, closed handles, mobile layout, flashing, saved-backup gating and failure reports.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
