const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {encode, writePacket, decode, SerialIO, USBBridge, RP2040Reader, capture, flashSize, defaultBaud} = require('../sws.js');
const {FakeRP2040} = require('./fake-rp2040.js');

async function setup(baudRate = 921600) {
  const fake = new FakeRP2040();
  const bridge = new USBBridge(fake); await bridge.open();
  await fake.open({baudRate});
  const io = new SerialIO(fake, 40);
  const reader = new RP2040Reader(io, bridge, undefined, baudRate);
  // Use the real activation method, but shorten its CPU-stop window for tests.
  return {fake, bridge, io, reader};
}
async function finish(env) { await env.io.close(); await env.bridge.close(); }

test('waveform packets agree with pinned pvvx fixtures; all byte replies decode', () => {
  const fixtures = JSON.parse(fs.readFileSync(__dirname + '/protocol-fixtures.json'));
  for (const item of fixtures.writes) assert.equal(Buffer.from(writePacket(item.address, item.data)).toString('hex'), item.packet);
  assert.equal(Buffer.from(encode([0xff])).toString('hex'), fixtures.stop);
  for (let value = 0; value <= 255; value++) {
    const response = Uint8Array.from({length: 9}, (_, i) => i === 8 ? 0xfe : (value & (0x80 >> i) ? 0x80 : 0xfe));
    assert.equal(decode(response), value);
  }
  assert.throws(() => decode(new Uint8Array(9)), /Invalid/);
  assert.throws(() => flashSize(Uint8Array.of(0xff, 0xff, 0xff)), /Unsupported/);
});

test('full 512 KiB read and second full verification match known bytes and hash', async () => {
  const env = await setup();
  try {
    let last;
    const result = await capture(env.reader, {activationMs: 100, fullVerify: true, pulseReset: true, progress: p => { last = p; }});
    assert.deepEqual(result.data, env.fake.memory);
    assert.equal(crypto.createHash('sha256').update(result.data).digest('hex'), '9aee50b8b6e9ee073b6053fd0262867baaf3b4176951cea7e93447500933e621');
    assert.equal(result.metadata.bytes, 524288);
    assert.equal(result.metadata.verification, 'two complete matching reads');
    assert.equal(result.metadata.resetEchoVerified, true);
    assert.equal(env.fake.blockRequests, 256);
    assert.deepEqual(last, {phase: 'Verifying', done: 524288, total: 524288});
    assert.equal(env.fake.registers.get(0xb3), 0);
    assert.equal(env.fake.registers.get(0x0d), 1);
    assert(env.fake.commands.every(c => [3, 0x9f, 0xab].includes(c)));
    assert.deepEqual(env.fake.signals.at(-1), {dataTerminalReady: false, requestToSend: false});
  } finally { await finish(env); }
  assert(env.fake.serialClosed);
});

test('sample verification covers address zero, every 64 KiB and the last bytes', async () => {
  const env = await setup();
  try {
    const result = await capture(env.reader, {activationMs: 100});
    assert.deepEqual(result.metadata.sampleAddresses, [0,65536,131072,196608,262144,327680,393216,458752,524032]);
    assert.equal(env.fake.blockRequests, 137);
  } finally { await finish(env); }
});

test('verification mismatch fails and releases SPI, FIFO and reset', async () => {
  const env = await setup(); env.fake.corruptAtBlock = 129;
  try {
    await assert.rejects(capture(env.reader, {activationMs: 100, fullVerify: true}), /Verification mismatch at 0x000000/);
    assert.equal(env.fake.registers.get(0xb3), 0); assert.equal(env.fake.registers.get(0x0d), 1);
    assert.equal(env.fake.registers.get(0x6f), 0x22);
  } finally { await finish(env); }
});

test('cancellation during a native block sends cancel and restores the tag', async () => {
  const env = await setup(); const controller = new AbortController();
  const original = env.fake.controlTransferIn.bind(env.fake);
  env.fake.controlTransferIn = async (...args) => {
    if (args[0].request === 0x11) { env.fake.stayBusy = true; controller.abort(); }
    return original(...args);
  };
  try {
    await assert.rejects(capture(env.reader, {activationMs: 100, signal: controller.signal}), {name: 'AbortError'});
    assert.equal(env.fake.cancelCount, 1); assert.equal(env.fake.registers.get(0x6f), 0x22);
  } finally { await finish(env); }
});

test('failed or short block payload is rejected', async () => {
  for (const mode of ['failAtBlock', 'shortPayload']) {
    const env = await setup(); env.fake[mode] = mode === 'failAtBlock' ? 1 : true;
    try {
      await assert.rejects(capture(env.reader, {activationMs: 100}), /block read failed|Incomplete RP2040/);
      assert.equal(env.fake.cancelCount, 1); assert.equal(env.fake.registers.get(0x6f), 0x22);
    } finally { await finish(env); }
  }
});

test('unknown flash ID and bridge firmware fail instead of guessing capacity', async () => {
  const env = await setup(); env.fake.jedec = [0,0,0];
  try {
    await assert.rejects(capture(env.reader, {activationMs: 100}), /Unsupported flash/);
    assert.equal(env.fake.blockRequests, 0);
    env.fake.version = 0x10002;
    await assert.rejects(env.bridge.status(), /v1.3/);
  } finally { await finish(env); }
});

test('speed bridge v1.4 is identified while unknown revisions remain rejected', async () => {
  const env = await setup();
  try {
    env.fake.version = 0x10004;
    assert.equal((await env.bridge.status()).version, '1.4');
    env.fake.version = 0x10007;
    await assert.rejects(env.bridge.status(), /supported RP2040 bridge/);
  } finally { await finish(env); }
});

test('v1.5 resets an earlier 826x width before serial activation and rejects a bad width echo', async () => {
  const fake = new FakeRP2040();
  assert.equal(fake.addressWidth, 2);
  const bridge = new USBBridge(fake);
  assert.equal((await bridge.open()).version, '1.5');
  assert.equal(fake.addressWidth, 3);
  assert.equal(fake.resets, 0);
  await bridge.close();
  const broken = new FakeRP2040();
  const transfer = broken.controlTransferIn.bind(broken);
  broken.controlTransferIn = async (setup, length) => {
    const reply = await transfer(setup, length);
    if (setup.request === 0x21) reply.data.setUint32(0, 2, true);
    return reply;
  };
  const other = new USBBridge(broken);
  try { await assert.rejects(other.open(), /width did not verify/); }
  finally { await other.close(); }
  assert.equal(broken.resets, 0);
});

test('a mismatched serial/USB pair fails before any CPU reset', async () => {
  const env = await setup(); const other = new FakeRP2040(); const otherBridge = new USBBridge(other);
  env.reader.bridge = otherBridge;
  try {
    await assert.rejects(capture(env.reader, {activationMs: 100}), /do not match/);
    assert.equal(env.fake.resets, 0); assert.equal(env.fake.blockRequests, 0);
  } finally { await finish(env); }
});

test('transport faults during capture reject the completed image', async () => {
  const env = await setup();
  try {
    await assert.rejects(capture(env.reader, {activationMs: 100, progress: p => { if (p.done === p.total) env.fake.faults++; }}), /transport faults/);
  } finally { await finish(env); }
});

test('serial timeout and disconnect terminate pending reads and unlock both streams', async () => {
  const env = await setup();
  await assert.rejects(env.io.readExactly(1), /Serial timeout/);
  const pending = env.io.readExactly(9);
  env.fake.rx.error(new Error('unplugged'));
  await assert.rejects(pending, /unplugged/);
  await finish(env);
  assert.equal(env.fake.readable.locked, false); assert.equal(env.fake.writable.locked, false);
});


test('capture timing and metadata follow selected baud; legacy defaults stay unchanged', async () => {
  assert.equal(defaultBaud('1.3'), 921600);
  assert.equal(defaultBaud('1.4'), 2000000);
  assert.equal(defaultBaud('1.5'), 2000000);
  for (const [baudRate, divisor] of [[921600, 52], [1500000, 32], [2000000, 24]]) {
    const env = await setup(baudRate);
    const logs = []; env.reader.log = message => logs.push(message);
    try {
      const result = await capture(env.reader, {activationMs: 100});
      assert.equal(result.metadata.baudRate, baudRate);
      assert.equal(result.metadata.divisor, divisor);
      assert.equal(env.fake.registers.get(0xb2), divisor);
      assert(logs.some(message => message.includes(`SWS divider ${divisor} (24 MHz`)));
    } finally { await finish(env); }
  }
});

test('reported 0x035000 block gives exact differing byte and remains rejected after a matching diagnostic read', async () => {
  const env = await setup(2000000);
  env.fake.corruptAtBlock = 129 + 0x35000 / 4096;
  env.fake.corruptOffset = 0xabc;
  const logs = []; env.reader.log = message => logs.push(message);
  try {
    await assert.rejects(capture(env.reader, {activationMs: 100, fullVerify: true}), /Verification mismatch at 0x035abc \(block 0x035000\)/);
    assert(logs.some(message => message.includes('1/4096 bytes differ')));
    assert(logs.some(message => message.includes('matches read 1. Backup remains rejected')));
    assert.equal(env.fake.registers.get(0x6f), 0x22);
  } finally { await finish(env); }
});

test('baud mismatch fails before calibration and releases the paired tag', async () => {
  const env = await setup(2000000); env.fake.baudRate = 921600;
  try {
    await assert.rejects(capture(env.reader, {activationMs: 100}), /baud rate 921600 does not match selected 2000000/);
    assert.equal(env.fake.blockRequests, 0);
    assert.equal(env.fake.registers.get(0x6f), 0x22);
  } finally { await finish(env); }
});


test('a diagnostic failure preserves rejection and a short first read cannot become a backup', async () => {
  for (const mode of ['diagnostic', 'short']) {
    const env = await setup();
    try {
      if (mode === 'diagnostic') {
        env.fake.corruptAtBlock = 129; env.fake.failAtBlock = 130;
        await assert.rejects(capture(env.reader, {activationMs: 100, fullVerify: true}), /Verification mismatch/);
      } else {
        const readFlash = env.reader.readFlash.bind(env.reader);
        env.reader.readFlash = async (...args) => (await readFlash(...args)).subarray(1);
        await assert.rejects(capture(env.reader, {activationMs: 100}), /Incomplete flash read/);
      }
      assert.equal(env.fake.registers.get(0x6f), 0x22);
    } finally { await finish(env); }
  }
});

 test('v1.6 supports two complete captures over repeated connections', async () => {
  const fake = new FakeRP2040(); fake.version = 0x10006;
  for (let session = 0; session < 2; session++) {
    if (session) fake.makeStreams();
    const bridge = new USBBridge(fake);
    assert.equal((await bridge.open()).version, '1.6');
    await fake.open({baudRate: 2000000});
    const io = new SerialIO(fake, 40);
    const reader = new RP2040Reader(io, bridge, undefined, 2000000);
    try {
      const result = await capture(reader, {activationMs: 100, fullVerify: true});
      assert.deepEqual(result.data, fake.memory);
    } finally { await io.close(); await bridge.close(); }
  }
  assert.equal(defaultBaud('1.6'), 2000000);
});

test('v1.5 reconnect skips an unnecessary width SET after legacy SWS activity', async () => {
  const fake = new FakeRP2040(); fake.addressWidth = 3;
  const original = fake.controlTransferOut.bind(fake);
  fake.controlTransferOut = async setup => {
    if (setup.request === 0x21) throw new Error('Active v1.5 bridge rejects SET');
    return original(setup);
  };
  const bridge = new USBBridge(fake);
  try { assert.equal((await bridge.open()).version, '1.5'); }
  finally { await bridge.close(); }
});
