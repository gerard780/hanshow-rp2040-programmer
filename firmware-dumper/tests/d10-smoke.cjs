// Complete guided flow against simulated USB/serial/flash and file-save APIs.
// No physical devices are used. The synthetic tag is admitted by synthetic
// product/waveform metadata; the actual pinned D10 binary is installed.
const {chromium} = require(process.argv[2] || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const F = require('../flash.js');
const asset = require('../d10/firmware.js');
const original = Uint8Array.from({length: 0x80000}, (_, i) => (i ^ (i >>> 8) ^ (i >>> 16)) & 255);
const syntheticManifest = {...asset.manifest,
  accepted_product_record: Buffer.from(original.subarray(0x7e000, 0x7e05c)).toString('hex'),
  supported_banks: [{id: 'synthetic-bank', sha256: crypto.createHash('sha256').update(original.subarray(0x78000, 0x7b000)).digest('hex')}]};
const url = process.env.D10_URL || 'http://127.0.0.1:8778/docs/d10/';
(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox']});
  try {
    async function scenario(options = {}) {
      const page = await browser.newPage({viewport: {width: 390, height: 844}}), errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.url().startsWith('http')) requests.push(request.url()); });
      await page.addInitScript({path: __dirname + '/fake-rp2040.js'});
      await page.addInitScript(({options, syntheticManifest}) => {
        window.mockBridge = new FakeRP2040();
        window.mockBridge.version = options.oldBridge ? 0x10005 : 0x10006;
        window.mockBridge.allowFlash = true;
        if (options.badProduct) window.mockBridge.memory[0x7e010] ^= 1;
        if (options.badWaveform) window.mockBridge.memory[0x79000] ^= 1;
        if (options.failedRecovery) window.mockBridge.ignoreErase = true;
        if (options.protectionFailure) window.mockBridge.failProtectionRestore = true;
        Object.defineProperty(navigator, 'usb', {value: {requestDevice: async () => window.mockBridge}});
        Object.defineProperty(navigator, 'serial', {value: {requestPort: async () => options.wrongPort ? new FakeRP2040() : window.mockBridge}});
        let included;
        Object.defineProperty(window, 'D10Firmware', {configurable: true,
          get: () => included, set: asset => {
            included = {...asset, manifest: syntheticManifest};
            if (options.badFirmware) included.base64 = btoa('bad firmware');
          }});
        window.savedBackup = null; window.pickerCalls = 0;
        window.showSaveFilePicker = async () => {
          window.pickerCalls++;
          if (options.cancelPicker) throw new DOMException('Cancelled', 'AbortError');
          return {name: 'before-D10-full.bin', createWritable: async () => ({
            write: async bytes => {
              if (options.diskFailure) throw new Error('Test disk is full');
              window.pendingBackup = Uint8Array.from(bytes);
            },
            close: async () => { window.savedBackup = window.pendingBackup; }, abort: async () => {},
          }), getFile: async () => ({arrayBuffer: async () => {
            const bytes = window.savedBackup.slice();
            if (options.corruptBackup) bytes[123] ^= 1;
            return bytes.buffer;
          }})};
        };
        if (options.unsupported) window.showSaveFilePicker = undefined;
        const timer = window.setTimeout;
        window.setTimeout = (fn, ms, ...args) => timer(fn, [5,25,50,60,100].includes(ms) ? 1 : ms, ...args);
      }, {options, syntheticManifest});
      await page.goto(url);
      await page.waitForFunction(() => !document.getElementById('firmware-status').textContent.includes('Checking'));
      assert.equal(await page.locator('input[type=file]').count(), 0);
      assert.equal(await page.locator('select').count(), 0);
      assert(await page.locator('#install').isDisabled());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.evaluate(() => {
        const activate = FirmwareDump.RP2040Reader.prototype.activate;
        FirmwareDump.RP2040Reader.prototype.activate = function (options) { return activate.call(this, {...options, activationMs: 100}); };
      });
      if (options.differingReads || options.blankReads) await page.evaluate(({differingReads}) => {
        const fullRead = FirmwareFlash.FlashSession.prototype.fullRead;
        FirmwareFlash.FlashSession.prototype.fullRead = async function (phase, ...args) {
          const bytes = await fullRead.call(this, phase, ...args);
          if (!differingReads) bytes.fill(255);
          else if (phase === 'Reading tag (pass 2)') bytes[0x1234] ^= 1;
          return bytes;
        };
      }, options);
      async function connect() {
        await page.locator('#connect-usb').click();
        if (options.oldBridge) return;
        await page.locator('#connect-serial').click();
        await page.waitForFunction(() => !document.getElementById('install').disabled);
        assert.equal(await page.evaluate(() => window.mockBridge.baudRate), 921600);
      }
      return {page, errors, requests, connect};
    }
    async function close(c) {
      assert.deepEqual(c.errors, []);
      assert(c.requests.every(request => request === url), 'Installer requested an external resource');
      await c.page.close();
    }
    const happy = await scenario(); await happy.connect();
    await happy.page.screenshot({path: '/tmp/d10-simple-ready.png', fullPage: true});
    await happy.page.locator('#install').click();
    await happy.page.waitForFunction(() => document.getElementById('status').textContent === 'D10 installed and verified.', {timeout: 120000});
    const expected = (await F.prepareFromBinary(Uint8Array.from(Buffer.from(asset.base64, 'base64')), original)).expected;
    assert.deepEqual(Uint8Array.from(await happy.page.evaluate(() => Array.from(window.mockBridge.memory))), expected);
    assert.deepEqual(Uint8Array.from(await happy.page.evaluate(() => Array.from(window.savedBackup))), original);
    assert.equal(await happy.page.evaluate(() => window.mockBridge.protection), 0x382c);
    assert.equal(await happy.page.evaluate(() => window.mockBridge.eraseOrder.at(-1)), 0);
    assert(await happy.page.locator('#after-install').isVisible());
    assert(await happy.page.locator('#connect-usb').isDisabled());
    const download = happy.page.waitForEvent('download'); await happy.page.locator('#report').click();
    const report = JSON.parse(fs.readFileSync(await (await download).path()));
    assert(report.verified && report.backupSaved && report.cpuResetVerified);
    assert.equal(report.firmwareSha256, asset.manifest.sha256);
    assert(report.events.findIndex(e => e.event === 'recovery_backup_saved') < report.events.findIndex(e => e.event === 'sector_attempted'));
    await happy.page.screenshot({path: '/tmp/d10-simple-complete.png', fullPage: true}); await close(happy);

    for (const options of [{badProduct:true}, {badWaveform:true}, {diskFailure:true}, {corruptBackup:true}, {wrongPort:true}]) {
      const c = await scenario(options); await c.connect(); await c.page.locator('#install').click();
      await c.page.waitForFunction(() => document.getElementById('status').textContent === 'D10 was not installed.', {timeout:60000});
      assert.deepEqual(await c.page.evaluate(() => window.mockBridge.eraseOrder), []);
      assert.deepEqual(await c.page.evaluate(() => window.mockBridge.statusWrites), []);
      assert(await c.page.locator('#after-install').isHidden()); await close(c);
    }
    const cancelled = await scenario({cancelPicker:true}); await cancelled.connect(); await cancelled.page.locator('#install').click();
    await cancelled.page.waitForFunction(() => document.getElementById('status').textContent.startsWith('No backup location'));
    assert.equal(await cancelled.page.evaluate(() => window.mockBridge.tx), 0); await close(cancelled);

    for (const options of [{differingReads:true}, {blankReads:true}]) {
      const c = await scenario(options); await c.connect(); await c.page.locator('#install').click();
      await c.page.waitForFunction(() => document.getElementById('status').textContent === 'Backup check failed. No firmware was written.', {timeout:60000});
      assert.match(await c.page.locator('#log').textContent(), /Read 1 SHA-256: [0-9a-f]{64}; Read 2 SHA-256: [0-9a-f]{64}|entirely FF/);
      if (options.differingReads) assert.match(await c.page.locator('#error').textContent(), /0x001234/);
      else assert.match(await c.page.locator('#error').textContent(), /Both full backup reads are entirely FF/);
      const download = c.page.waitForEvent('download'); await c.page.locator('#report').click();
      const report = JSON.parse(fs.readFileSync(await (await download).path()));
      assert(!report.backupValidation.valid && report.cpuResetVerified);
      assert.equal(report.backupValidation.mismatchedBytes, options.differingReads ? 1 : 0);
      assert.deepEqual(await c.page.evaluate(() => window.mockBridge.eraseOrder), []);
      assert.deepEqual(await c.page.evaluate(() => window.mockBridge.statusWrites), []);
      assert.equal(await c.page.evaluate(() => window.savedBackup), null);
      assert(await c.page.locator('#after-install').isHidden()); await close(c);
    }

    const stop = await scenario(); await stop.connect(); await stop.page.locator('#install').click();
    await stop.page.waitForFunction(() => window.mockBridge.eraseOrder.length > 0, {timeout:60000});
    await stop.page.locator('#cancel').click();
    await stop.page.waitForFunction(() => document.getElementById('status').textContent === 'Stopped safely. Your previous firmware was restored.', {timeout:60000});
    assert.deepEqual(Uint8Array.from(await stop.page.evaluate(() => Array.from(window.mockBridge.memory))), original);
    assert.equal(await stop.page.evaluate(() => window.mockBridge.protection), 0x382c);
    assert(await stop.page.locator('#after-install').isHidden()); await close(stop);

    const failed = await scenario({failedRecovery:true}); await failed.connect(); await failed.page.locator('#install').click();
    await failed.page.waitForFunction(() => document.getElementById('status').textContent === 'Installation stopped. Keep the tag powered.', {timeout:60000});
    assert(await failed.page.locator('#connect-usb').isDisabled());
    assert(await failed.page.locator('#report').isVisible());
    assert.notEqual(await failed.page.evaluate(() => window.mockBridge.registers.get(0x6f)), 0x22); await close(failed);

    const protection = await scenario({protectionFailure:true}); await protection.connect(); await protection.page.locator('#install').click();
    await protection.page.waitForFunction(() => document.getElementById('status').textContent === 'Installation stopped. Keep the tag powered.', {timeout:120000});
    assert(await protection.page.locator('#connect-usb').isDisabled());
    assert.notEqual(await protection.page.evaluate(() => window.mockBridge.registers.get(0x6f)), 0x22); await close(protection);

    const bad = await scenario({badFirmware:true}); assert(await bad.page.locator('#connect-usb').isDisabled()); await close(bad);
    const unsupported = await scenario({unsupported:true}); assert(await unsupported.page.locator('#compatibility').isVisible());
    assert(await unsupported.page.locator('#connect-usb').isDisabled()); await close(unsupported);
    const old = await scenario({oldBridge:true}); await old.connect();
    assert(await old.page.locator('#connect-serial').isDisabled()); assert.match(await old.page.locator('#error').textContent(), /v1.6/); await close(old);
    console.log('D10 browser checks passed: guided install, pinned firmware, saved backup before erase, whole-flash preservation, target rejection, backup failures, wrong port, cancellation before access, held recovery/protection failures, unsupported browser, old bridge, mobile layout and no external requests.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
