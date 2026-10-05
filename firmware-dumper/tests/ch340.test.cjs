const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {SerialIO, CH340Reader, capture, isCH340, ch340Filters} = require('../sws.js');
const {FakeCH340} = require('./fake-ch340.js');

async function setup() {
  const fake = new FakeCH340(); await fake.open({baudRate: 921600});
  const io = new SerialIO(fake, 40);
  const reader = new CH340Reader(io);
  return {fake, io, reader};
}

// Preserve actual SWS read/echo/decoder code, shorten only inter-transaction
// delays in this synthetic test. Physical and UI code retain their real waits.
async function withoutBenchDelays(operation) {
  const original = global.setTimeout;
  global.setTimeout = (callback, ms, ...args) => original(callback, ms === 25 || ms === 50 ? 0 : ms, ...args);
  try { return await operation(); } finally { global.setTimeout = original; }
}

test('CH340 captures two matching full reads over fragmented UART samples without USB', async () => withoutBenchDelays(async () => {
  const env = await setup(); env.fake.fragmentReplies = true;
  try {
    const result = await capture(env.reader, {activationMs: 100, fullVerify: true});
    assert.deepEqual(result.data, env.fake.memory);
    assert.equal(result.metadata.bytes, 65536);
    assert.equal(result.metadata.baudRate, 921600);
    assert.equal(result.metadata.verification, 'two complete matching reads');
    assert.equal(result.metadata.transport.programmer, 'CH340/CH341 USB UART');
    assert.equal(result.metadata.transport.usbVendorId, 0x1a86);
    assert.equal(env.fake.blockRequests, 0);
    assert.equal(env.fake.flashReads, 512);
    assert(env.fake.triggers > 131072);
    assert.equal(crypto.createHash('sha256').update(result.data).digest('hex'), crypto.createHash('sha256').update(env.fake.memory).digest('hex'));
    assert(env.fake.commands.every(command => [3, 0x9f, 0xab].includes(command)));
    assert.equal(env.fake.registers.get(0x6f), 0x22);
    assert.deepEqual(env.fake.signals.at(-1), {dataTerminalReady: false, requestToSend: false});
  } finally { await env.io.close(); }
}));

test('CH340 mismatches are rejected after a diagnostic reread and the tag is released', async () => withoutBenchDelays(async () => {
  const env = await setup(); env.fake.corruptAtRead = 257; env.fake.corruptAtOffset = 0x80;
  const logs = []; env.reader.log = message => logs.push(message);
  try {
    await assert.rejects(capture(env.reader, {activationMs: 100, fullVerify: true}), /Verification mismatch at 0x000080/);
    assert(logs.some(message => message.includes('matches read 1. Backup remains rejected')));
    assert.equal(env.fake.registers.get(0x0d), 1);
    assert.equal(env.fake.registers.get(0xb3), 0);
    assert.equal(env.fake.registers.get(0x6f), 0x22);
  } finally { await env.io.close(); }
}));

test('CH340 cancellation after a read trigger ends the transaction and restores reset', async () => withoutBenchDelays(async () => {
  const env = await setup(); const controller = new AbortController();
  const write = env.fake.write.bind(env.fake);
  env.fake.write = bytes => { write(bytes); if (env.fake.flashReads && bytes.length === 1) controller.abort(); };
  try {
    await assert.rejects(capture(env.reader, {activationMs: 100, signal: controller.signal}), {name: 'AbortError'});
    assert.equal(env.fake.registers.get(0x6f), 0x22);
    assert.equal(env.fake.registers.get(0x0d), 1);
  } finally { await env.io.close(); }
}));

test('CH340 rejects wrong port and unknown flash, and recognizes supported UART IDs', async () => withoutBenchDelays(async () => {
  for (const filter of ch340Filters) assert(isCH340(filter));
  assert(!isCH340({usbVendorId: 0xcafe, usbProductId: 0x4012}));
  const env = await setup();
  try {
    env.fake.vendorId = 0xcafe;
    await assert.rejects(capture(env.reader, {activationMs: 100}), /Select a CH340/);
    assert.equal(env.fake.resets, 0);
    env.fake.vendorId = 0x1a86; env.fake.jedec = [0, 0, 0];
    await assert.rejects(capture(env.reader, {activationMs: 100}), /Unsupported flash/);
    assert.equal(env.fake.flashReads, 0);
    assert.equal(env.fake.registers.get(0x6f), 0x22);
  } finally { await env.io.close(); }
}));

test('CH340 drains every waveform chunk even during activation bursts before sending the next', async () => {
  const {writePacket} = require('../sws.js');
  const env = await setup(); let pendingEcho = false;
  const echo = env.fake.echo.bind(env.fake), write = env.fake.write.bind(env.fake);
  env.fake.echo = bytes => {
    if (bytes.length % 10 !== 0) return echo(bytes);
    pendingEcho = true;
    setTimeout(() => { pendingEcho = false; echo(bytes); }, 2);
  };
  env.fake.write = bytes => {
    assert.equal(pendingEcho, false, 'UART waveform chunks were queued together');
    write(bytes);
  };
  try {
    await env.io.send(writePacket(0x602, [5]), false); // 60 + 10 bytes.
    await env.io.send(writePacket(0xb2, [52]));
    assert.equal(env.io.available, 0);
    env.fake.invalidSample = true;
    await assert.rejects(env.reader.read(0x7d, 1), /Invalid SWS reply/);
    assert.equal(env.fake.readAddress, null); // Stop sent after decoder failure.
  } finally { await env.io.close(); }
});
