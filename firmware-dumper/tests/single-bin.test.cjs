const {test} = require('node:test');
const assert = require('node:assert/strict');
const {FakeRP2040} = require('./fake-rp2040.js');
const {SerialIO, USBBridge, RP2040Reader} = require('../sws.js');
const {validateBinary, prepareFromBinary, installApplication, crc32, digest} = require('../flash.js');
const {fixture} = require('./flash-fixture.cjs');
function binary(length = 4108) {
  const data = Uint8Array.from({length}, (_, i) => i & 255);
  data.set([0x4b, 0x4e, 0x4c, 0x54], 8);
  const view = new DataView(data.buffer); view.setUint32(24, length, true);
  view.setUint32(length - 4, (crc32(data.subarray(0, -4)) ^ 0xffffffff) >>> 0, true);
  return data;
}
async function setup() {
  const fake = new FakeRP2040(); fake.allowFlash = true; fake.version = 0x10006;
  const before = fake.memory.slice(), plan = await fixture(before);
  const bridge = new USBBridge(fake); await bridge.open(); await fake.open({baudRate: 1500000});
  const io = new SerialIO(fake, 80), reader = new RP2040Reader(io, bridge, undefined, 1500000);
  const options = {activationMs: 100, apply: true, saveRecoveryBackup: false,
    saveBackup: async () => { throw new Error('Must not request a saved backup'); }};
  return {fake, before, plan, reader, options, close: async () => { await io.close(); await bridge.close(); }};
}
test('raw and FF-padded binaries build the same fresh per-tag plan with zero last', async () => {
  const before = new FakeRP2040().memory, raw = binary();
  const parsed = await validateBinary(raw);
  assert.equal(parsed.firmwareBytes, raw.length); assert.equal(parsed.application.length, 8192);
  assert(parsed.application.subarray(raw.length).every(b => b === 255));
  const a = await prepareFromBinary(raw, before), b = await prepareFromBinary(parsed.application, before);
  assert.deepEqual(a, b); assert.deepEqual(a.meta.sectors_in_write_order, [4096, 0]);
  assert.deepEqual(a.expected.subarray(8192), before.subarray(8192));
  assert.deepEqual(a.recovery, before.subarray(0, 8192));
  assert.equal(a.meta.backup_sha256, await digest(before));
  const largest = await validateBinary(binary(129588));
  assert.equal(largest.application.length, 0x20000);
});
test('malformed, truncated, oversized, non-FF padded and full-flash files reject before hardware', async () => {
  const badCRC = binary(); badCRC[100] ^= 1;
  const badPadding = (await validateBinary(binary())).application; badPadding[5000] = 0;
  const wrongLength = binary(); new DataView(wrongLength.buffer).setUint32(24, 99999, true);
  for (const data of [new Uint8Array(524288), new Uint8Array(64), binary().slice(0, -1), badCRC, badPadding, wrongLength]) {
    await assert.rejects(installApplication({}, data, {apply: true, saveRecoveryBackup: false}));
  }
});
test('single-bin installs without a saved file and verifies the full expected image', async () => {
  const e = await setup();
  try {
    const report = await installApplication(e.reader, e.plan.application, e.options);
    assert(report.verified && report.cpuResetVerified); assert(!report.backupRequested && !report.backupSaved);
    assert.equal(report.inputMode, 'single-bin'); assert.equal(report.recoveryStorage, 'browser memory only');
    assert.deepEqual(e.fake.eraseOrder, [4096, 0]); assert.deepEqual(e.fake.memory, e.plan.expected);
    assert.equal(e.fake.protection, 0x382c);
  } finally { await e.close(); }
});
test('single-bin saving is default and an unavailable save callback prevents unlock', async () => {
  const e = await setup(); delete e.options.saveRecoveryBackup; delete e.options.saveBackup;
  try {
    await assert.rejects(installApplication(e.reader, e.plan.application, e.options), /Choose a recovery backup/);
    assert.deepEqual(e.fake.statusWrites, []); assert.deepEqual(e.fake.eraseOrder, []);
    assert.deepEqual(e.fake.memory, e.before);
  } finally { await e.close(); }
});
test('single-bin dry run builds a plan but does not unlock, erase or program', async () => {
  const e = await setup(); e.options.apply = false;
  try {
    const report = await installApplication(e.reader, e.plan.application, e.options);
    assert(report.verified && !report.apply); assert.deepEqual(report.plannedSectors, [4096, 0]);
    assert.deepEqual(e.fake.memory, e.before); assert.deepEqual(e.fake.statusWrites, []);
  } finally { await e.close(); }
});
test('skipping the saved backup still requires two matching reads before any write', async () => {
  const e = await setup();
  e.options.progress = update => {
    if (update.phase === 'Reading tag (pass 1)' && update.done === update.total) e.fake.corruptAtBlock = e.fake.blockRequests + 1;
  };
  try {
    await assert.rejects(installApplication(e.reader, e.plan.application, e.options), /Fresh full backups differ/);
    assert.deepEqual(e.fake.statusWrites, []); assert.deepEqual(e.fake.eraseOrder, []);
  } finally { await e.close(); }
});
test('cancel during single-bin install recovers from memory with saving disabled', async () => {
  const e = await setup(), controller = new AbortController(); e.options.signal = controller.signal;
  e.options.onEvent = name => { if (name === 'sector_verified') controller.abort(); };
  try {
    let report;
    try { await installApplication(e.reader, e.plan.application, e.options); } catch (error) { report = error.report; }
    assert(report && report.recoveryVerified && report.cpuResetVerified && !report.backupSaved);
    assert.deepEqual(e.fake.memory, e.before); assert.equal(e.fake.protection, 0x382c);
  } finally { await e.close(); }
});

test('failed unsaved recovery retains an emergency original snapshot without putting it in the JSON report', async () => {
  const e = await setup(); const reg = e.reader.reg.bind(e.reader); let pages = 0;
  e.reader.reg = async (address, data) => {
    if (address === 0x0c && data[0] === 2 && ++pages >= 2) throw new Error('Recovery write unavailable');
    return reg(address, data);
  };
  try {
    let failure;
    try { await installApplication(e.reader, e.plan.application, e.options); } catch (error) { failure = error; }
    assert(failure.report.cpuKeptHalted && !failure.report.backupSaved && !failure.report.cpuResetVerified);
    assert.deepEqual(failure.recoveryBackup, e.before);
    assert(!Object.hasOwn(failure.report, 'recoveryBackup'));
  } finally { await e.close(); }
});
