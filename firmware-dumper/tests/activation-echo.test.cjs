const {test} = require('node:test');
const assert = require('node:assert/strict');
const {FakeRP2040} = require('./fake-rp2040.js');
const {SerialIO, USBBridge, RP2040Reader, encode} = require('../sws.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(timeout = 1500) {
  const fake = new FakeRP2040(); fake.version = 0x10006;
  const write = fake.write.bind(fake);
  let tail = Promise.resolve(), pending = 0, maximum = 0;
  // Model host USB queue acceptance separately from physical SWS transmission.
  // Each CDC chunk has scheduling latency plus its baud-dependent wire time.
  fake.writable = new WritableStream({write(bytes) {
    const copy = bytes.slice(); pending += copy.length; maximum = Math.max(maximum, pending);
    tail = tail.then(async () => {
      await pause(3 + copy.length * 10000 / fake.baudRate);
      write(copy); pending -= copy.length;
    });
  }});
  const bridge = new USBBridge(fake); await bridge.open(); await fake.open({baudRate:460800});
  const io = new SerialIO(fake, timeout), reader = new RP2040Reader(io, bridge, undefined, 460800);
  return {fake,io,reader,maximum:()=>maximum,close:async()=>{await tail;await io.close();await bridge.close();}};
}
test('negative control reproduces an echo mismatch when blind bursts are not drained', async () => {
  const e = await setup(); e.reader.drainActivationEcho = undefined;
  try {
    await assert.rejects(e.reader.activate({activationMs:100}), /Serial echo mismatch/);
    assert(e.reader.paired); assert(e.maximum() > 420);
    assert.deepEqual(e.fake.eraseOrder, []); assert.deepEqual(e.fake.statusWrites, []);
  } finally { await e.close(); }
});
test('paced bursts activate correctly with the same delayed physical echo model', async () => {
  const e = await setup();
  try {
    const identity = await e.reader.activate({activationMs:100});
    assert.equal(identity.chipId, '026255'); assert.equal(identity.divisor, 104);
    assert.equal(e.reader.activationStage, 'ready');
    assert(e.maximum() <= 420, 'Unacknowledged activation traffic exceeded one bounded burst');
    assert.deepEqual(e.fake.eraseOrder, []); assert.deepEqual(e.fake.statusWrites, []);
  } finally { await e.close(); }
});
test('missing activation echo stops with an explicit stage instead of entering backup reads', async () => {
  const e = await setup(80), echo = e.fake.echo.bind(e.fake); let dropped = false;
  e.fake.echo = bytes => {
    if (!dropped && e.reader.activationStage === 'halt_echo_drain') { dropped = true; echo(bytes.subarray(1)); }
    else echo(bytes);
  };
  try {
    let failure;
    try { await e.reader.activate({activationMs:100}); } catch (error) { failure = error; }
    assert.match(failure.message, /Serial timeout/);
    assert.deepEqual(failure.activationDiagnostic, {stage:'halt_echo_drain',baudRate:460800,portAssociated:true});
    assert.equal(e.fake.blockRequests, 0); assert.equal(e.fake.programCount, 0);
  } finally { await e.close(); }
});
test('normal command echo checking remains strict after paced activation', async () => {
  const e = await setup();
  try {
    await e.reader.activate({activationMs:100});
    const echo = e.fake.echo.bind(e.fake);
    e.fake.echo = bytes => { const copy = bytes.slice(); copy[0] ^= 1; echo(copy); };
    await assert.rejects(e.io.send(encode([0xff])), /Serial echo mismatch/);
    assert.equal(e.fake.programCount, 0);
  } finally { await e.close(); }
});
test('cancellation during echo draining prevents calibration and flash access', async () => {
  const e = await setup(), controller = new AbortController(), echo = e.fake.echo.bind(e.fake);
  e.fake.echo = bytes => { echo(bytes); if(e.reader.activationStage === 'halt_echo_drain') controller.abort(); };
  try {
    await assert.rejects(e.reader.activate({activationMs:100,signal:controller.signal}), {name:'AbortError'});
    assert.deepEqual(e.fake.commands, []); assert.equal(e.fake.blockRequests, 0);
  } finally { await e.close(); }
});
