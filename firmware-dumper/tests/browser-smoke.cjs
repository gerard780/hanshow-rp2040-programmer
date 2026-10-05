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
    await page.addInitScript({path: __dirname + '/fake-rp2040.js'});
    await page.addInitScript(() => {
      window.mockBridge = new FakeRP2040();
      Object.defineProperty(navigator, 'usb', {value: {requestDevice: async () => window.mockBridge}});
      Object.defineProperty(navigator, 'serial', {value: {requestPort: async () => window.mockBridge}});
    });
    await page.goto(process.env.DUMPER_URL || 'http://127.0.0.1:8765/firmware-dumper/');
    assert(await page.locator('#verify').isChecked());
    assert(await page.locator('#dump').isDisabled());
    await page.screenshot({path: '/tmp/firmware-dumper-desktop.png', fullPage: true});
    async function connect() {
      await page.locator('#usb').click();
      await page.locator('#serial').click();
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
    assert.equal(metadata.resetEchoVerified, true);
    assert(await page.locator('#dump').isDisabled()); // handles close after capture
    assert.match(await page.locator('#status').textContent(), /backup ready/);
    await page.screenshot({path: '/tmp/firmware-dumper-result.png', fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path: '/tmp/firmware-dumper-mobile.png', fullPage: true});

    // Reconnect with fresh streams, then force a verification mismatch.
    await page.evaluate(() => { window.mockBridge = new FakeRP2040(); window.mockBridge.corruptAtBlock = 129; });
    await connect(); await page.locator('#dump').click();
    assert(await page.locator('#result').isHidden());
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Backup failed:'), {timeout: 30000});
    assert(await page.locator('#result').isHidden());
    assert.equal(await page.locator('#binary').getAttribute('href'), null);
    assert.match(await page.locator('#status').textContent(), /Verification mismatch/);

    // Cancel during capture and verify a new complete-download link is absent.
    await page.evaluate(() => { window.mockBridge = new FakeRP2040(); window.mockBridge.stayBusy = true; });
    await connect(); await page.locator('#dump').click();
    await page.waitForFunction(() => window.mockBridge.blockRequests > 0);
    await page.locator('#cancel').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Cancelled.'));
    assert(await page.locator('#result').isHidden());
    assert.equal(await page.evaluate(() => window.mockBridge.cancelCount), 1);
    assert.equal(await page.evaluate(() => window.mockBridge.signals.at(-1).requestToSend), false);
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: complete downloads, hash/report, mismatch, cancellation, closed handles, mobile layout.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
