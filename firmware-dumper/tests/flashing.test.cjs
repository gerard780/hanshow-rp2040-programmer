const {test} = require('node:test');
const assert = require('node:assert/strict');
const {FakeRP2040} = require('./fake-rp2040.js');
const {SerialIO, USBBridge, RP2040Reader, equal} = require('../sws.js');
const {validatePlan, checkBackup, installApplication, FlashSession, digest} = require('../flash.js');
const {fixture} = require('./flash-fixture.cjs');
async function setup() {
  const fake = new FakeRP2040(); fake.allowFlash = true; fake.version = 0x10006;
  const original = fake.memory.slice(), plan = await fixture(original);
  const bridge = new USBBridge(fake); await bridge.open(); await fake.open({baudRate: 2000000});
  const io = new SerialIO(fake, 80), reader = new RP2040Reader(io, bridge, undefined, 2000000);
  const options = {activationMs: 100, apply: true, saveBackup: async bytes => {
    assert.equal(fake.eraseOrder.length, 0); assert.equal(fake.statusWrites.length, 0);
    assert.deepEqual(bytes, original); return digest(bytes);
  }};
  return {fake, original, plan, io, bridge, reader, options, close: async () => { await io.close(); await bridge.close(); }};
}
async function expectFailure(env, pattern) {
  let error;
  try { await installApplication(env.reader, env.plan, env.options); }
  catch (e) { error = e; }
  assert(error); assert.match(error.message, pattern); return error.report;
}
test('successful image writes zero last, saves backup first, preserves upper flash and protection', async () => {
  const e = await setup();
  try {
    const report = await installApplication(e.reader, e.plan, e.options);
    assert(report.verified && report.backupSaved && report.cpuResetVerified);
    assert.deepEqual(e.fake.eraseOrder, [4096, 0]); assert.equal(e.fake.programCount, 32);
    assert.deepEqual(e.fake.memory, e.plan.expected); assert.deepEqual(e.fake.memory.subarray(0x20000), e.original.subarray(0x20000));
    assert.equal(e.fake.protection, 0x382c); assert.deepEqual(e.fake.statusWrites, [0x3800, 0x382c]);
  } finally { await e.close(); }
});
test('dry run never writes status, erases or programs', async () => {
  const e = await setup(); e.options.apply = false;
  try {
    const report = await installApplication(e.reader, e.plan, e.options);
    assert(report.verified && !report.apply); assert.deepEqual(e.fake.memory, e.original);
    assert.deepEqual(e.fake.statusWrites, []); assert.deepEqual(e.fake.eraseOrder, []);
  } finally { await e.close(); }
});
test('stale same-tag plan and unsaved backup refuse all writes', async () => {
  for (const failure of ['stale', 'save']) {
    const e = await setup();
    if (failure === 'stale') e.plan.meta.backup_sha256 = 'wrong';
    else e.options.saveBackup = async () => 'wrong';
    try {
      await expectFailure(e, /differs from prepared plan|Saved recovery backup/);
      assert.deepEqual(e.fake.memory, e.original); assert.deepEqual(e.fake.statusWrites, []);
    } finally { await e.close(); }
  }
});
test('partial page failure in sector zero restores both sectors zero last before CPU reset', async () => {
  const e = await setup(); const reg = e.reader.reg.bind(e.reader); let pages = 0, injected = false;
  e.reader.reg = async (address, data) => {
    if (address === 0x0c && data[0] === 2 && ++pages === 18 && !injected) { injected = true; throw new Error('Injected partial write'); }
    return reg(address, data);
  };
  try {
    const report = await expectFailure(e, /partial write/);
    assert(report.recoveryVerified && report.cpuResetVerified); assert.deepEqual(e.fake.memory, e.original);
    assert.deepEqual(e.fake.eraseOrder, [4096, 0, 4096, 0]); assert.equal(e.fake.protection, 0x382c);
  } finally { await e.close(); }
});
test('cancel after erase completes sector then restores original; cancel before writes never unlocks', async () => {
  for (const afterWrite of [false, true]) {
    const e = await setup(), controller = new AbortController(); e.options.signal = controller.signal;
    e.options.onEvent = name => { if (name === (afterWrite ? 'sector_verified' : 'recovery_backup_saved')) controller.abort(); };
    try {
      const report = await expectFailure(e, /cancelled/);
      assert(report.cpuResetVerified); assert.deepEqual(e.fake.memory, e.original);
      if (afterWrite) assert(report.recoveryVerified);
      else assert.deepEqual(e.fake.statusWrites, []);
    } finally { await e.close(); }
  }
});
test('failed recovery or protection restoration prevents CPU reset', async () => {
  for (const mode of ['recovery', 'protection']) {
    const e = await setup();
    if (mode === 'protection') e.fake.failProtectionRestore = true;
    else {
      const reg = e.reader.reg.bind(e.reader); let pages = 0;
      e.reader.reg = async (address, data) => {
        if (address === 0x0c && data[0] === 2 && ++pages >= 2) throw new Error('Write transport unavailable');
        return reg(address, data);
      };
    }
    try {
      const report = await expectFailure(e, /Write transport|cleanup or recovery/);
      assert(report.cpuKeptHalted); assert(!report.cpuResetVerified);
      assert.notEqual(e.fake.registers.get(0x6f), 0x22);
    } finally { await e.close(); }
  }
});
test('ignored erase and changed preserved flash are rejected', async () => {
  const e = await setup(); e.fake.ignoreErase = true;
  try { const report = await expectFailure(e, /did not become erased/); assert(report.cpuKeptHalted); assert.equal(e.fake.programCount, 0); }
  finally { await e.close(); }
  const fake = new FakeRP2040(); const plan = await fixture(fake.memory);
  plan.expected[0x7e000] ^= 1; plan.meta.expected_full_flash_sha256 = await digest(plan.expected);
  await assert.rejects(checkBackup(await validatePlan(plan.meta, plan.application, plan.expected, plan.recovery), fake.memory), /preserved flash/);
});
test('tampered CRC, sector order, address limits and SPI policy reject before mutation', async () => {
  const fake = new FakeRP2040(); const plan = await fixture(fake.memory);
  plan.application[100] ^= 1; plan.expected.set(plan.application);
  plan.meta.expected_full_flash_sha256 = await digest(plan.expected); plan.meta.firmware_sha256 = await digest(plan.application);
  await assert.rejects(validatePlan(plan.meta, plan.application, plan.expected, plan.recovery), /checksum/);
  const p = await fixture(fake.memory); p.meta.sectors_in_write_order = [0, 4096];
  await assert.rejects(checkBackup(p, fake.memory), /sector zero/);
  p.meta.write_start = 4096;
  await assert.rejects(validatePlan(p.meta, p.application, p.expected, p.recovery), /geometry/);
  const flash = new FlashSession({});
  await assert.rejects(flash.spi([6]), /disabled/); flash.allowWrites = true; flash.unlocked = true;
  await assert.rejects(flash.spi([0x20, 2, 0, 0]), /application-only/);
  await assert.rejects(flash.spi([2, 0, 1, 255, 1, 2]), /boundary/);
  await assert.rejects(flash.spi([0xc7]), /opcode/);
});
test('old bridge and unknown flash refuse installation; a mismatched serial device is never reset', async () => {
  for (const mode of ['version', 'flash', 'pair']) {
    const e = await setup();
    if (mode === 'version') e.fake.version = 0x10005;
    if (mode === 'flash') e.fake.jedec = [0xc8, 0x60, 0x13];
    if (mode === 'pair') e.reader.bridge = new USBBridge(new FakeRP2040());
    try {
      await expectFailure(e, /v1.6|EB6013|do not match/); assert.deepEqual(e.fake.eraseOrder, []);
      if (mode === 'pair') assert.equal(e.fake.resets, 0);
    } finally { await e.close(); }
  }
});
