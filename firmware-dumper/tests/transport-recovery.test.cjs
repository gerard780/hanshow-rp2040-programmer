const {test} = require('node:test');
const assert = require('node:assert/strict');
const {FakeRP2040} = require('./fake-rp2040.js');
const {SerialIO, USBBridge, RP2040Reader} = require('../sws.js');
const {crc32, installApplication} = require('../flash.js');

async function setup(baudRate = 1500000) {
  const fake = new FakeRP2040(); fake.version = 0x10006; fake.allowFlash = true;
  const original = fake.memory.slice(), application = original.slice(0, 0x8000);
  application.set([0x4b,0x4e,0x4c,0x54],8);
  new DataView(application.buffer).setUint32(24, application.length, true);
  for (let i=0x3000;i<application.length;i++) application[i] ^= 0x55;
  new DataView(application.buffer).setUint32(application.length-4,(crc32(application.subarray(0,-4))^0xffffffff)>>>0,true);
  const bridge = new USBBridge(fake); await bridge.open(); await fake.open({baudRate});
  const io = new SerialIO(fake,80), reader = new RP2040Reader(io,bridge,undefined,baudRate);
  return {fake,original,application,reader,io,bridge,options:{apply:true,activationMs:100,saveRecoveryBackup:false},
    close:async()=>{await io.close();await bridge.close();}};
}
test('each serial chunk is physically acknowledged before the next; a damaged chunk stops the remaining page', async()=>{
  let rx, writes=0, delivered=0;
  const port={readable:new ReadableStream({start(c){rx=c}}),writable:new WritableStream({write(bytes){
    assert.equal(writes,delivered);writes++;
    setTimeout(()=>{const echo=bytes.slice();if(writes===2)echo[5]^=1;delivered++;rx.enqueue(echo);},2);
  }}),close:async()=>{}};
  const io=new SerialIO(port,100);
  try {
    let error;try{await io.send(new Uint8Array(600).fill(0xfe));}catch(e){error=e;}
    assert.match(error.message,/Serial echo mismatch/);assert.equal(writes,2);
    assert.deepEqual(error.transportDiagnostic,{kind:'echo_mismatch',encodedOffset:65,expected:254,received:255,packetBytes:600});
  }finally{await io.close();}
});
test('2 Mbaud writes fail before activation, unlock or erase while read-only checks remain allowed',async()=>{
  const e=await setup(2000000);
  try{
    await assert.rejects(installApplication(e.reader,e.application,e.options),/1.5 Mbaud or 921600/);
    assert.equal(e.fake.tx,0);assert.deepEqual(e.fake.eraseOrder,[]);assert.deepEqual(e.fake.statusWrites,[]);assert.equal(e.fake.resets,0);
    const report=await installApplication(e.reader,e.application,{...e.options,apply:false});assert(report.verified);
  }finally{await e.close();}
});
test('the reported fifth-sector failure restores all attempted sectors after draining stale echo, preserving original flash',async()=>{
  const e=await setup(), execute=e.fake.executeFlash.bind(e.fake);let corrupted=false,resyncs=0;
  e.fake.executeFlash=command=>{
    execute(command);
    if(command[0]===2 && command[1]===0 && command[2]===0x7f && !corrupted){corrupted=true;e.fake.memory[0x7005]^=1;}
  };
  const resync=e.reader.resynchronize.bind(e.reader);
  e.reader.resynchronize=async()=>{resyncs++;e.fake.rx.enqueue(Uint8Array.from([1,2,3]));await resync();};
  try{
    let error;try{await installApplication(e.reader,e.application,e.options);}catch(failure){error=failure;}
    assert.match(error.message,/sector 0x7000, address 0x7005/);
    assert.deepEqual(error.report.attemptedSectors,[0x3000,0x4000,0x5000,0x6000,0x7000]);
    assert.deepEqual(error.report.writtenSectors,[0x3000,0x4000,0x5000,0x6000]);
    assert.equal(error.report.sectorDiagnostic.firstMismatchAddress,0x7005);
    assert(error.report.recoveryVerified && error.report.cpuResetVerified);assert.equal(resyncs,2);
    assert.deepEqual(e.fake.memory,e.original);assert.equal(e.fake.protection,0x382c);
    assert.equal(error.report.events.filter(x=>x.event==='recovery_sector_verified').length,5);
    assert(!e.fake.signals.some(x=>x.requestToSend));
  }finally{await e.close();}
});
test('failed transport resynchronization keeps the CPU halted and retains the original unsaved backup',async()=>{
  const e=await setup();
  // Activate normally, then make the transport permanently unavailable on the first erase.
  const reg=RP2040Reader.prototype.reg.bind(e.reader);e.reader.reg=reg;
  const execute=e.fake.executeFlash.bind(e.fake);
  e.fake.executeFlash=command=>{execute(command);if(command[0]===0x20)e.reader.reg=async()=>{throw new Error('Unavailable serial transport');};};
  try{
    let error;try{await installApplication(e.reader,e.application,e.options);}catch(failure){error=failure;}
    assert(error.report.cpuKeptHalted && !error.report.cpuResetVerified);
    assert.deepEqual(error.recoveryBackup,e.original);assert.notEqual(e.fake.registers.get(0x6f),0x22);
  }finally{await e.close();}
});
