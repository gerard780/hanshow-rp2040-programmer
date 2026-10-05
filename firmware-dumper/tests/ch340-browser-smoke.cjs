// Web Serial-only UI test, deliberately without WebUSB.
const {chromium} = require(process.argv[2] || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport: {width: 1200, height: 1000}});
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.url().startsWith('http')) requests.push(r.url()); });
    await page.addInitScript({path: __dirname + '/fake-rp2040.js'});
    await page.addInitScript({path: __dirname + '/fake-ch340.js'});
    await page.addInitScript(() => {
      window.mockBridge = new FakeCH340(); window.serialChoices = [];
      Object.defineProperty(navigator, 'usb', {value: undefined});
      Object.defineProperty(navigator, 'serial', {value: {requestPort: async options => {
        window.serialChoices.push(options); return window.mockBridge;
      }}});
    });
    const url = process.env.DUMPER_URL || 'http://127.0.0.1:8768/';
    await page.goto(url);
    assert(await page.locator('#usb').isDisabled());
    assert(await page.locator('#compatibility').isHidden()); // Serial mode remains usable.
    await page.locator('#adapter').selectOption('ch340');
    assert(await page.locator('#usb').isHidden());
    assert(await page.locator('#rp2040-guide').isHidden());
    assert(await page.locator('#ch340-guide').isVisible());
    assert(!(await page.locator('#reset').isChecked()));
    assert(await page.locator('#baud').isDisabled());
    assert.equal(await page.locator('#baud').inputValue(), '921600');
    assert(!(await page.locator('#serial').isDisabled()));
    async function connect() {
      await page.locator('#serial').click();
      assert(await page.locator('#adapter').isDisabled());
      await page.locator('#activation').fill('100');
      assert(!(await page.locator('#dump').isDisabled()));
    }
    await connect();
    assert.equal(await page.evaluate(() => window.mockBridge.baudRate), 921600);
    assert.deepEqual(await page.evaluate(() => window.mockBridge.signals[0]), {dataTerminalReady: false, requestToSend: false});
    assert((await page.evaluate(() => window.serialChoices[0].filters)).some(f => f.usbVendorId === 0x1a86 && f.usbProductId === 0x7523));
    await page.locator('#dump').click();
    try {
      await page.waitForFunction(() => !document.getElementById('result').hidden, null, {timeout: 90000});
    } catch (error) {
      console.error(await page.locator('#log').textContent()); throw error;
    }
    const binaryDownload = page.waitForEvent('download'); await page.locator('#binary').click();
    const data = fs.readFileSync(await (await binaryDownload).path());
    const expected = await page.evaluate(() => Array.from(window.mockBridge.memory));
    assert.deepEqual(data, Buffer.from(expected));
    const reportDownload = page.waitForEvent('download'); await page.locator('#report').click();
    const metadata = JSON.parse(fs.readFileSync(await (await reportDownload).path()));
    assert.equal(metadata.sha256, crypto.createHash('sha256').update(data).digest('hex'));
    assert.equal(metadata.verification, 'two complete matching reads');
    assert.equal(metadata.transport.programmer, 'CH340/CH341 USB UART');
    assert.equal(metadata.baudRate, 921600);
    assert.equal(metadata.resetEchoVerified, true);
    assert.equal(await page.evaluate(() => window.mockBridge.blockRequests), 0);
    assert(await page.locator('#dump').isDisabled());
    assert(!(await page.locator('#adapter').isDisabled()));
    await page.setViewportSize({width: 390, height: 844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path: '/tmp/firmware-dumper-ch340.png', fullPage: true});

    // Reject a non-CH340 port before opening serial or resetting a tag.
    await page.evaluate(() => { window.mockBridge = new FakeCH340(); window.mockBridge.vendorId = 0xcafe; });
    await page.locator('#serial').click();
    assert.match(await page.locator('#log').textContent(), /Select a CH340/);
    assert.equal(await page.evaluate(() => window.mockBridge.resets), 0);
    assert(await page.locator('#dump').isDisabled());

    // Cancel on the first flash block, release controls and hide all downloads.
    await page.evaluate(() => { window.mockBridge = new FakeCH340(); });
    await connect(); await page.locator('#dump').click();
    await page.waitForFunction(() => window.mockBridge.flashReads > 0);
    await page.locator('#cancel').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Cancelled.'));
    assert(await page.locator('#result').isHidden());
    assert.equal(await page.locator('#binary').getAttribute('href'), null);
    assert.equal(await page.evaluate(() => window.mockBridge.registers.get(0x6f)), 0x22);
    assert.deepEqual(await page.evaluate(() => window.mockBridge.signals.at(-1)), {dataTerminalReady: false, requestToSend: false});
    assert.deepEqual(errors, []);
    assert(requests.every(request => request === url));
    console.log('CH340 browser checks passed: no WebUSB, adapter/wiring selection, serial filters, full verified downloads, report, wrong port, cancellation, cleanup, mobile layout, standalone HTML.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
