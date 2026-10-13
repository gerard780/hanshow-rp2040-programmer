const {test} = require('node:test');
const assert = require('node:assert/strict');
const {decodeStatus, StatusReader, LineDecoder, parseUART, decodeJournal} = require('../discovery.js');
const {D9_HEADER, crc32, validateBinary, prepareFromBinary} = require('../flash.js');
const {status,journal}=require('./discovery-fixture.cjs');
class Characteristic {
  constructor() { this.listener = null; this.writes = []; this.reply = true; }
  addEventListener(_, fn) { this.listener = fn; }
  removeEventListener(_, fn) { if (this.listener === fn) this.listener = null; }
  notify(frame) { this.listener?.({target: {value: frame}}); }
  async writeValueWithoutResponse(bytes) { this.writes.push([...bytes]); if (this.reply) this.notify(status()); }
}
function discoveryBinary() {
  const b = new Uint8Array(4108); b.fill(0); b.set([0x4b,0x4e,0x4c,0x54], 8); b.set(D9_HEADER, 128);
  const d = new DataView(b.buffer); d.setUint32(24, b.length, true); d.setUint32(b.length-4, (crc32(b.subarray(0,-4))^0xffffffff)>>>0, true); return b;
}
test('D8/D9 frames decode offsets, signed temperature and journal flags without treating refresh success as confirmation', () => {
  const s = decodeStatus(status()); assert.equal(s.attempt, 77); assert.equal(s.temperature, -4); assert.equal(s.waitSeconds, 5);
  assert(s.lastSuccess && !s.confirmed && s.journalHealthy); assert.equal(decodeStatus(status(1)).journalHealthy, null);
  const offset = new Uint8Array(30); offset.set(new Uint8Array(status().buffer), 7);
  assert.equal(decodeStatus(new DataView(offset.buffer, 7, 20)).attempt, 77);
  assert.throws(() => decodeStatus(status(3))); assert.throws(() => decodeStatus(new Uint8Array(19)));
});
test('Bluetooth reader sends status-only frames and handles synchronous replies', async () => {
  const c = new Characteristic(), r = new StatusReader(); r.attach(c);
  assert.equal((await r.readStatus()).attempt, 77); assert.equal((await r.readStatus()).profile, 2);
  assert(c.writes.every(b => JSON.stringify(b) === '[67,112,0,0,0,0,0]')); r.disconnect(); assert.equal(c.listener, null);
});
test('overlapping, invalid, late and timed-out reads cannot cross sessions; pending write is bounded', async () => {
  const c = new Characteristic(); c.reply = false; const r = new StatusReader(()=>{}, 15); r.attach(c);
  const waiting = r.readStatus(); await assert.rejects(r.readStatus(), /pending/); c.notify(status(3));
  await assert.rejects(waiting, /timed out/); assert(!r.connected); assert.equal(c.listener, null); c.notify(status());
  const hung = new Characteristic(); hung.writeValueWithoutResponse = () => new Promise(()=>{}); r.attach(hung);
  await assert.rejects(r.readStatus(), /timed out/); assert(!r.connected);
});
test('split UART chunks, UTF8, CRLF and final partial lines are retained and discovery fields decoded', () => {
  const lines = [], decoder = new LineDecoder(line=>lines.push(line));
  const bytes = new TextEncoder().encode('N437 D8 start P2 attempt=77 pattern=1\r\nN437 D9 panel=-4 bank=1 band=2 profile=2 attempt=77\nµ end');
  for (let i=0;i<bytes.length;i+=3) decoder.push(bytes.slice(i,i+3)); decoder.finish();
  assert.equal(lines.length, 3); assert.equal(lines[2], 'µ end'); assert.equal(parseUART(lines[0]).attempt, 77);
  assert.equal(parseUART(lines[1]).temperature, -4); assert.equal(parseUART('N437 D8 state=6 pass=1 BUSY=1').panelState, 6);
  assert.equal(parseUART('other console text'), null);
});
test('journal header/record CRCs, negative temperature and torn slots decode from sector or full backup', () => {
  const j=journal(), decoded=decodeJournal(j); assert.equal(decoded.records[0].attempt,77); assert.equal(decoded.records[0].temperature,-4);
  assert.equal(decoded.records[0].uptimeMs,12345); assert.deepEqual(decoded.invalidSlots,[]);
  const full=new Uint8Array(524288); full.set(j,0x1f000); assert.deepEqual(decodeJournal(full),decoded);
  j[38]=128; new DataView(j.buffer).setUint32(60,crc32(j.subarray(32,60)),true);
  assert.deepEqual(decodeJournal(j).records[0].flagNames,['driver_timeout']);
  j[40]^=1; assert.deepEqual(decodeJournal(j).invalidSlots,[0]); assert.equal(decodeJournal(j).records.length,0);
  j[0]=0; assert.throws(()=>decodeJournal(j),/header/); assert.throws(()=>decodeJournal(new Uint8Array(32)),/512 KiB/);
});
test('D9 raw binary initializes its reserved journal and preserves valid-header existing records on reflash', async () => {
  const before = Uint8Array.from({length:524288},(_,i)=>i&255), firmware=discoveryBinary();
  const parsed=await validateBinary(firmware); assert(parsed.discoveryJournal); assert.equal(parsed.application.length,131072);
  assert.deepEqual([...parsed.application.subarray(0x1f000,0x1f020)],D9_HEADER);
  let plan=await prepareFromBinary(firmware,before); assert.equal(plan.meta.discovery_journal.action,'initialized');
  assert.deepEqual(plan.expected.subarray(0x20000),before.subarray(0x20000));
  const j=journal(); before.set(j,0x1f000); plan=await prepareFromBinary(firmware,before);
  assert.equal(plan.meta.discovery_journal.action,'preserved'); assert.deepEqual(plan.application.subarray(0x1f000),j);
  assert(!plan.meta.sectors_in_write_order.includes(0x1f000));
  const captured=parsed.application.slice(); captured.set(j,0x1f000);
  await assert.rejects(validateBinary(captured),/Do not distribute/);
});
test('ordinary binaries do not initialize a journal and a damaged embedded descriptor does not trigger detection', async () => {
  const b=discoveryBinary(); b[128]^=1; new DataView(b.buffer).setUint32(b.length-4,(crc32(b.subarray(0,-4))^0xffffffff)>>>0,true);
  const p=await validateBinary(b); assert(!p.discoveryJournal); assert.equal(p.application.length,8192);
});
module.exports={status,journal};
