const {test} = require('node:test');
const assert = require('node:assert/strict');
const {FakeRP2040} = require('./fake-rp2040.js');
const {SerialIO, USBBridge, RP2040Reader} = require('../sws.js');
const {installApplication, digest} = require('../flash.js');
const {fixture} = require('./flash-fixture.cjs');
async function setup() {
  const fake = new FakeRP2040(); fake.allowFlash = true; fake.version = 0x10006;
  const original = fake.memory.slice(), plan = await fixture(original);
  const bridge = new USBBridge(fake); await bridge.open(); await fake.open({baudRate:460800});
  const io = new SerialIO(fake,80), reader = new RP2040Reader(io,bridge,undefined,460800);
  const options = {activationMs:100,apply:true,sectorWriteAttempts:3,
    saveBackup:async bytes => {assert.deepEqual(fake.eraseOrder,[]);assert.deepEqual(bytes,original);return digest(bytes);}};
  return {fake,original,plan,reader,options,close:async()=>{await io.close();await bridge.close();}};
}
function corruptProgram(e, persistent=false) {
  const execute=e.fake.executeFlash.bind(e.fake);let injected=false,recovery=false;
  e.options.onEvent=name=>{if(name==='installation_failed')recovery=true;};
  e.fake.executeFlash=command=>{
    execute(command);
    if(command[0]===2 && command[1]===0 && command[2]===0x1f && command[3]===0 && !recovery && (persistent||!injected)) {
      e.fake.memory[0x1005]^=1;injected=true;
    }
  };
}
async function failure(e, pattern) {
  let error;try{await installApplication(e.reader,e.plan.application,e.options);}catch(caught){error=caught;}
  assert(error);assert.match(error.message,pattern);return error.report;
}
test('transient programmed-data damage rewrites only that sector and preserves sector-zero-last ordering',async()=>{
  const e=await setup();corruptProgram(e);
  try{
    const report=await installApplication(e.reader,e.plan.application,e.options);
    assert(report.verified&&report.backupSaved&&report.cpuResetVerified);
    assert.deepEqual(e.fake.eraseOrder,[4096,4096,0]);assert.deepEqual(e.fake.memory,e.plan.expected);
    const attempts=report.sectorWriteAttempts.filter(a=>a.offset===4096);
    assert.equal(attempts.length,2);assert.equal(attempts[0].writeDiagnostic.phase,'verify');
    assert.equal(attempts[1].status,'verified');assert.equal(e.fake.protection,0x382c);
  }finally{await e.close();}
});
test('two matching intended-sector reads resolve a transient verification error without another erase',async()=>{
  const e=await setup(),block=e.reader.blockRead.bind(e.reader);let injected=false;
  e.reader.blockRead=async(...args)=>{
    const bytes=await block(...args);
    if(args[1]===4096&&e.fake.spiAddress===0x2000&&e.fake.programCount>0&&!injected){bytes[5]^=1;injected=true;}
    return bytes;
  };
  try{
    const report=await installApplication(e.reader,e.plan.application,e.options);
    assert(report.verified);assert.deepEqual(e.fake.eraseOrder,[4096,0]);
    assert.equal(report.sectorWriteAttempts[1].status,'verified_existing');
    assert.deepEqual(e.fake.memory,e.plan.expected);
  }finally{await e.close();}
});
test('one ignored erase can be retried after repeatable sector readback',async()=>{
  const e=await setup(),execute=e.fake.executeFlash.bind(e.fake);let ignored=false;
  e.fake.executeFlash=command=>{
    const skip=command[0]===0x20&&!ignored;
    if(skip){ignored=true;e.fake.ignoreErase=true;}
    execute(command);if(skip)e.fake.ignoreErase=false;
  };
  try{
    const report=await installApplication(e.reader,e.plan.application,e.options);
    assert(report.verified);assert.deepEqual(e.fake.eraseOrder,[4096,4096,0]);
    assert.equal(report.sectorWriteAttempts[0].writeDiagnostic.phase,'blank_check');
  }finally{await e.close();}
});
test('three failed forward writes stop and restore the original application',async()=>{
  const e=await setup();corruptProgram(e,true);
  try{
    const report=await failure(e,/readback mismatch/);
    assert.equal(report.sectorWriteAttempts.length,3);
    assert(report.sectorWriteAttempts.every(a=>a.status==='failed'));
    assert(report.recoveryVerified&&report.cpuResetVerified);
    assert.deepEqual(e.fake.eraseOrder,[4096,4096,4096,4096]);
    assert.deepEqual(e.fake.memory,e.original);assert.equal(e.fake.protection,0x382c);
  }finally{await e.close();}
});
test('unstable retry readback or transport faults stop before another erase',async()=>{
  for(const mode of ['readback','faults']){
    const e=await setup();corruptProgram(e);const previous=e.options.onEvent,block=e.reader.blockRead.bind(e.reader);
    let retryReads=0,erasesBeforeRecovery;
    e.reader.blockRead=async(...args)=>{const bytes=await block(...args);if(mode==='readback'&&retryReads&&args[1]===4096){if(retryReads--===2)bytes[7]^=1;}return bytes;};
    e.options.onEvent=name=>{
      previous(name);
      if(name==='sector_write_retry'){if(mode==='faults')e.fake.faults++;else retryReads=2;}
      if(name==='installation_failed')erasesBeforeRecovery=e.fake.eraseOrder.length;
    };
    try{
      const report=await failure(e,/Sector retry reads differ|transport faults/);
      assert.equal(erasesBeforeRecovery,1);assert.equal(report.sectorWriteAttempts.length,2);
      assert(report.recoveryVerified);assert.deepEqual(e.fake.memory,e.original);
    }finally{await e.close();}
  }
});
test('changed target or protection prevents a second forward erase',async()=>{
  for(const mode of ['target','protection']){
    const e=await setup();corruptProgram(e);const previous=e.options.onEvent;let erasesBeforeRecovery;
    e.options.onEvent=name=>{
      previous(name);
      if(name==='sector_write_retry'){if(mode==='target')e.fake.flashUid[0]^=1;else e.fake.protection=0x382c;}
      if(name==='installation_failed')erasesBeforeRecovery=e.fake.eraseOrder.length;
    };
    try{
      const report=await failure(e,/Target changed before sector retry|Protection changed before sector retry/);
      assert.equal(erasesBeforeRecovery,1);assert.equal(report.sectorWriteAttempts.length,2);
      assert(report.cpuKeptHalted&&!report.cpuResetVerified);
    }finally{await e.close();}
  }
});
test('cancelling after a failed write skips retries and completes recovery',async()=>{
  const e=await setup(),controller=new AbortController();corruptProgram(e);const previous=e.options.onEvent;
  e.options.signal=controller.signal;
  e.options.onEvent=name=>{previous(name);if(name==='sector_write_attempt_failed')controller.abort();};
  try{
    const report=await failure(e,/readback mismatch/);
    assert.equal(report.sectorWriteAttempts.length,1);assert(report.recoveryVerified&&report.cpuResetVerified);
    assert.deepEqual(e.fake.memory,e.original);
  }finally{await e.close();}
});
test('invalid write-attempt limits reject before hardware access',async()=>{
  for(const sectorWriteAttempts of [0,4,1.5,'3'])await assert.rejects(installApplication({},new Uint8Array(),{sectorWriteAttempts}),/integer from 1 to 3/);
});
