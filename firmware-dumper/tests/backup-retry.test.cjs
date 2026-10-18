const {test} = require('node:test');
const assert = require('node:assert/strict');
const {FakeRP2040} = require('./fake-rp2040.js');
const {SerialIO, USBBridge, RP2040Reader} = require('../sws.js');
const {installApplication, digest} = require('../flash.js');
const {fixture} = require('./flash-fixture.cjs');

async function setup() {
  const fake = new FakeRP2040(); fake.allowFlash = true; fake.version = 0x10006;
  const original = fake.memory.slice(), plan = await fixture(original);
  const bridge = new USBBridge(fake); await bridge.open(); await fake.open({baudRate: 460800});
  const io = new SerialIO(fake, 80), reader = new RP2040Reader(io, bridge, undefined, 460800);
  const state = {resyncs: 0, saved: 0, completedReads: 0};
  const resync = reader.resynchronize.bind(reader);
  reader.resynchronize = async () => { state.resyncs++; await resync(); };
  const options = {activationMs: 100, apply: true, backupReadAttempts: 3,
    progress: p => { if (p.phase.startsWith('Reading tag') && p.done === p.total) state.completedReads++; },
    saveBackup: async bytes => {
      state.saved++; assert.deepEqual(fake.eraseOrder, []); assert.deepEqual(fake.statusWrites, []);
      assert.deepEqual(bytes, original); return digest(bytes);
    }};
  return {fake, original, plan, reader, state, options, close: async () => { await io.close(); await bridge.close(); }};
}
function corruptSecondRead(e, persistent = false, mode = 'mismatch') {
  const progress = e.options.progress; let injected = false;
  e.options.progress = p => {
    progress(p);
    if (p.phase === 'Reading tag (pass 1)' && p.done === p.total && (persistent || !injected)) {
      e.fake[mode === 'mismatch' ? 'corruptAtBlock' : 'failAtBlock'] = e.fake.blockRequests + 1;
      injected = true;
    }
  };
}
async function failure(e, pattern) {
  let error;
  try { await installApplication(e.reader, e.plan.application, e.options); } catch (caught) { error = caught; }
  assert(error); assert.match(error.message, pattern);
  assert.deepEqual(e.fake.eraseOrder, []); assert.deepEqual(e.fake.statusWrites, []);
  assert.equal(e.state.saved, 0);
  return error.report;
}
test('a transient mismatch is discarded and a complete new matching pair permits installation', async () => {
  const e = await setup(); corruptSecondRead(e);
  try {
    const report = await installApplication(e.reader, e.plan.application, e.options);
    assert(report.verified && report.backupSaved && report.cpuResetVerified);
    assert.equal(e.state.resyncs, 1); assert.equal(e.state.completedReads, 4); assert.equal(e.state.saved, 1);
    assert.equal(report.backupReadAttempts.length, 2);
    assert(!report.backupReadAttempts[0].validation.valid && report.backupReadAttempts[1].validation.valid);
    assert.deepEqual(e.fake.memory, e.plan.expected); assert.equal(e.fake.protection, 0x382c);
  } finally { await e.close(); }
});
test('persistent disagreements stop after three independent pairs without saving or writing', async () => {
  const e = await setup(); corruptSecondRead(e, true);
  try {
    const report = await failure(e, /Fresh full backups differ/);
    assert.equal(e.state.completedReads, 6); assert.equal(e.state.resyncs, 2);
    assert.equal(report.backupReadAttempts.length, 3);
    assert(report.backupReadAttempts.every(attempt => !attempt.validation.valid));
    assert(report.cpuResetVerified); assert.deepEqual(e.fake.memory, e.original);
  } finally { await e.close(); }
});
test('a transient native read exception retries with two complete fresh reads', async () => {
  const e = await setup(); corruptSecondRead(e, false, 'transport'); e.options.apply = false;
  try {
    const report = await installApplication(e.reader, e.plan.application, e.options);
    assert(report.verified); assert.equal(e.state.resyncs, 1); assert.equal(e.state.completedReads, 3);
    assert.match(report.backupReadAttempts[0].error, /block read failed/);
    assert(report.backupReadAttempts[1].validation.valid); assert.deepEqual(e.fake.eraseOrder, []);
  } finally { await e.close(); }
});
test('changed target or protection stops before the next pair rather than being retried', async () => {
  for (const mode of ['target', 'protection']) {
    const e = await setup(); corruptSecondRead(e);
    e.options.onEvent = name => {
      if (name === 'backup_read_retry') {
        if (mode === 'target') e.fake.flashUid[0] ^= 1;
        else e.fake.protection = 0x002c;
      }
    };
    try {
      const report = await failure(e, /Target changed before backup retry|Protection changed before backup retry/);
      assert.equal(e.state.completedReads, 2); assert.equal(report.backupReadAttempts.length, 1);
    } finally { await e.close(); }
  }
});
test('cancellation after a rejected pair prevents retries', async () => {
  const e = await setup(), controller = new AbortController(); corruptSecondRead(e);
  e.options.signal = controller.signal;
  e.options.onEvent = name => { if (name === 'backup_read_attempt_failed') controller.abort(); };
  try {
    const report = await failure(e, /Fresh full backups differ/);
    assert.equal(e.state.resyncs, 0); assert.equal(e.state.completedReads, 2);
    assert.equal(report.backupReadAttempts.length, 1);
  } finally { await e.close(); }
});
test('resynchronization errors and fault counters cannot be bypassed by retries', async () => {
  for (const mode of ['resync', 'faults']) {
    const e = await setup(); corruptSecondRead(e);
    if (mode === 'resync') e.reader.resynchronize = async () => { throw new Error('Read retry resync failed'); };
    else e.options.onEvent = name => { if (name === 'backup_read_retry') e.fake.faults++; };
    try {
      const report = await failure(e, /resync failed|transport faults/);
      assert.equal(e.state.completedReads, 2); assert.equal(report.backupReadAttempts.length, 1);
    } finally { await e.close(); }
  }
});
test('invalid retry limits reject before hardware access', async () => {
  for (const backupReadAttempts of [0, 4, 1.5, '3']) {
    await assert.rejects(installApplication({}, new Uint8Array(), {backupReadAttempts}), /integer from 1 to 3/);
  }
});
