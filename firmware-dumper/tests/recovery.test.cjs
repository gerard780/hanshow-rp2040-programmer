const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const {FakeRP2040} = require('./fake-rp2040.js');
const {SerialIO,USBBridge,RP2040Reader} = require('../sws.js');
const F = require('../flash.js');
const R = require('../recovery.js');
const {fixture} = require('./flash-fixture.cjs');
// Accelerate only intentional target settle delays; serial/USB timeouts remain
// unchanged. These are protocol/state tests with instantaneous simulated flash.
const timer = global.setTimeout;
before(()=>{global.setTimeout=(fn,ms,...args)=>timer(fn,[25,50,60,100].includes(ms)?1:ms,...args);});
after(()=>{global.setTimeout=timer;});
async function setup(baudRate = 921600) {
  const fake=new FakeRP2040();fake.version=0x10006;fake.allowFlash=true;fake.protection=0;
  const original=fake.memory.slice();
  for(const address of [0x3000,0x4000,0x5000,0x6000,0x7000]) fake.memory[address]^=1;
  const source={apply:true,verified:false,cpuKeptHalted:true,chipId:'026255',jedecId:'eb6013',bridgeVersion:'1.6',applicationBytes:131072,
    protectionOriginal:44,backupSha256:await F.digest(original),flashUidSha256:await F.digest(fake.flashUid),
    programmerSha256:await F.digest(new TextEncoder().encode(fake.serialNumber))};
  const bridge=new USBBridge(fake);await bridge.open();await fake.open({baudRate});
  const io=new SerialIO(fake,1500),reader=new RP2040Reader(io,bridge,undefined,baudRate);
  return {fake,original,source,reader,options:{resetWireDisconnected:true,activationMs:100},
    close:async()=>{await io.close();await bridge.close();}};
}
test('backup hash/size, report identity and reset-wire confirmation reject before hardware access',async()=>{
  const e=await setup();
  try{
    await assert.rejects(R.validateSource(e.original.slice(0,131072),e.source),/complete tag backup/);
    const wrong=e.original.slice();wrong[500]^=1;
    await assert.rejects(R.validateSource(wrong,e.source),/does not match/);
    await assert.rejects(R.validateSource(e.original,{...e.source,chipId:'other'}),/Unsupported/);
    await assert.rejects(R.recoverApplication({},e.original,e.source),/Remove the wire/);
    await assert.rejects(R.restoreAndInstall(e.reader,e.original,e.source,new Uint8Array(64),e.options));
    assert.equal(e.fake.tx,0);assert.deepEqual(e.fake.eraseOrder,[]);assert.equal(e.fake.resets,0);
  }finally{await e.close();}
});
test('460800 recovery restores the mixed D10 failure state using 64-byte writes without legacy status sampling',async()=>{
  const e=await setup(460800),read=e.reader.read.bind(e.reader),reg=e.reader.reg.bind(e.reader);
  e.fake.protection=44;e.fake.memory.set(e.original.subarray(0x3000,0x4000),0x3000);
  e.fake.memory.fill(255,0x4800,0x4900);e.fake.memory.fill(255,0x5300,0x6000);
  e.reader.read=async(address,...args)=>{assert.notEqual(address,0x0c,'Legacy SPI reply sampling must not be used');return read(address,...args);};
  e.reader.reg=async(address,data)=>{
    if(address===0x0c&&data[0]===2)assert.equal(data.length,68);
    if(address===0x6f){assert.deepEqual(e.fake.memory,e.original);assert.equal(e.fake.protection,44);}
    return reg(address,data);
  };
  try{
    const report=await R.recoverApplication(e.reader,e.original,e.source,{...e.options,apply:true,nativeStatus:true,sectorWriteAttempts:3});
    assert(report.verified&&report.imageVerified&&report.protectionVerified&&report.cpuResetVerified);
    assert(!report.plannedSectors.includes(0x3000));assert(report.restoredSectors.includes(0x4000)&&report.restoredSectors.includes(0x5000));
    assert.equal(report.baudRate,460800);assert.equal(report.nativeStatus,true);assert.equal(e.fake.resets,1);
  }finally{await e.close();}
});
test('recovery retries a stable misprogrammed sector after checking identity and does not touch sector zero early',async()=>{
  const e=await setup(460800),execute=e.fake.executeFlash.bind(e.fake);let damaged=false;
  e.fake.executeFlash=command=>{execute(command);if(command[0]===2&&command[2]===0x4f&&command[3]===0xc0&&!damaged){damaged=true;e.fake.memory[0x4809]^=1;}};
  e.fake.memory[0]^=1;
  try{
    const report=await R.recoverApplication(e.reader,e.original,e.source,{...e.options,apply:true,nativeStatus:true,sectorWriteAttempts:3});
    assert(report.verified);assert.deepEqual(e.fake.eraseOrder,[0x3000,0x4000,0x4000,0x5000,0x6000,0x7000,0]);
    assert.equal(report.sectorWriteAttempts.find(x=>x.status==='failed').sectorDiagnostic.firstMismatchAddress,0x4809);
    assert.deepEqual(e.fake.memory,e.original);assert.equal(e.fake.resets,1);
  }finally{await e.close();}
});
test('a lost readback after successful recovery programming is accepted only after two matching reads',async()=>{
  const e=await setup(460800),block=e.reader.blockRead.bind(e.reader);let dropped=false;
  e.reader.blockRead=async(...args)=>{const data=await block(...args);if(args[1]===4096&&e.fake.programCount===64&&!dropped){dropped=true;throw new Error('Lost final readback acknowledgement');}return data;};
  try{
    const report=await R.recoverApplication(e.reader,e.original,e.source,{...e.options,apply:true,nativeStatus:true,sectorWriteAttempts:3});
    assert(report.verified);assert.equal(e.fake.eraseOrder.filter(x=>x===0x3000).length,1);
    assert(report.sectorWriteAttempts.some(x=>x.offset===0x3000&&x.status==='already_verified'));assert.equal(e.fake.resets,1);
  }finally{await e.close();}
});
test('recovery retry guards reject new transport faults, changed UID/protection, unstable reads and cancellation',async()=>{
  for(const mode of ['fault','uid','protection','reads','cancel']){
    const e=await setup(460800),execute=e.fake.executeFlash.bind(e.fake),controller=new AbortController();let damaged=false;
    e.fake.executeFlash=command=>{execute(command);if(command[0]===2&&command[2]===0x3f&&command[3]===0xc0&&!damaged){damaged=true;e.fake.memory[0x3809]^=1;}};
    e.options.onEvent=name=>{if(name==='recovery_sector_attempt_failed'){
      if(mode==='fault')e.fake.faults++;
      if(mode==='uid')e.fake.flashUid[0]^=1;
      if(mode==='protection')e.fake.protection=44;
      if(mode==='cancel')controller.abort();
    }};
    if(mode==='reads'){
      const block=e.reader.blockRead.bind(e.reader);let retryReads=0;
      e.reader.blockRead=async(...args)=>{const data=await block(...args);if(damaged&&args[1]===4096&&++retryReads===3)data[10]^=1;return data;};
    }
    try{
      let error;try{await R.recoverApplication(e.reader,e.original,e.source,{...e.options,apply:true,nativeStatus:true,sectorWriteAttempts:3,signal:controller.signal});}catch(e){error=e;}
      assert(error,mode);assert(error.report.cpuKeptHalted,mode);assert.deepEqual(e.fake.eraseOrder,[0x3000],mode);assert.equal(e.fake.resets,0,mode);
      assert.equal(e.fake.protection,mode==='uid'?0:44,mode);
      if(mode==='uid')assert.match(error.report.protectionError,/identity changed/);
    }finally{await e.close();}
  }
});
test('persistent recovery corruption exhausts three attempts and leaves CPU halted with protection restored',async()=>{
  const e=await setup(460800),execute=e.fake.executeFlash.bind(e.fake);
  e.fake.executeFlash=command=>{execute(command);if(command[0]===2&&command[2]===0x3f&&command[3]===0xc0)e.fake.memory[0x3809]^=1;};
  try{
    let error;try{await R.recoverApplication(e.reader,e.original,e.source,{...e.options,apply:true,nativeStatus:true,sectorWriteAttempts:3});}catch(e){error=e;}
    assert(error.report.cpuKeptHalted);assert.equal(error.report.sectorWriteAttempts.length,3);
    assert.deepEqual(e.fake.eraseOrder,[0x3000,0x3000,0x3000]);assert.equal(e.fake.resets,0);assert.equal(e.fake.protection,44);
  }finally{await e.close();}
});
test('checks verify the original tag without reset, erases, programs or protection writes',async()=>{
  const e=await setup();
  try{
    const report=await R.recoverApplication(e.reader,e.original,e.source,e.options);
    assert(report.checkPassed && report.cpuKeptHalted && !report.cpuResetAttempted);
    assert.deepEqual(report.plannedSectors,[0x3000,0x4000,0x5000,0x6000,0x7000]);
    assert.equal(e.fake.resets,0);assert.deepEqual(e.fake.statusWrites,[]);assert.deepEqual(e.fake.eraseOrder,[]);
    assert(!e.fake.signals.some(x=>x.requestToSend));
  }finally{await e.close();}
});
test('wrong hardware, mismatching reads, altered factory data and unexpected protection prevent all mutations',async()=>{
  for(const mode of ['programmer','tag','reads','factory','protection']){
    const e=await setup();
    if(mode==='programmer')e.source.programmerSha256='0'.repeat(64);
    if(mode==='tag')e.fake.flashUid[0]^=1;
    if(mode==='reads')e.options.progress=u=>{if(u.phase==='Checking tag (pass 1)'&&u.done===u.total)e.fake.corruptAtBlock=e.fake.blockRequests+1;};
    if(mode==='factory')e.fake.memory[0x7e000]^=1;
    if(mode==='protection')e.fake.protection=0x3800;
    try{
      await assert.rejects(R.recoverApplication(e.reader,e.original,e.source,{...e.options,apply:true}));
      assert.deepEqual(e.fake.eraseOrder,[]);assert.deepEqual(e.fake.statusWrites,[]);assert.equal(e.fake.resets,0);
    }finally{await e.close();}
  }
});
test('original-image recovery uses64-byte pages and resets only after complete equality and exact original protection',async()=>{
  const e=await setup();const reg=e.reader.reg.bind(e.reader);let resetObserved=false;
  e.reader.reg=async(address,data)=>{
    if(address===0x6f){assert.deepEqual(data,[0x22]);assert.deepEqual(e.fake.memory,e.original);assert.equal(e.fake.protection,44);resetObserved=true;}
    if(address===0x0c && data[0]===2)assert(data.length===68);
    return reg(address,data);
  };
  try{
    const report=await R.recoverApplication(e.reader,e.original,e.source,{...e.options,apply:true});
    assert(report.verified && report.cpuResetVerified && resetObserved);
    assert.deepEqual(e.fake.memory,e.original);assert.equal(e.fake.resets,1);assert.equal(e.fake.protection,44);
  }finally{await e.close();}
});
test('combined restore/application install has no intermediate reset and preserves original upper flash',async()=>{
  const e=await setup();const plan=await fixture(e.original),reg=e.reader.reg.bind(e.reader);
  e.reader.reg=async(address,data)=>{
    if(address===0x6f){assert.deepEqual(data,[0x22]);assert.deepEqual(e.fake.memory,plan.expected);assert.equal(e.fake.protection,44);}
    if(address===0x0c&&data[0]===2)assert(data.length<=68);
    return reg(address,data);
  };
  try{
    const report=await R.restoreAndInstall(e.reader,e.original,e.source,plan.application,{...e.options,apply:true});
    assert(report.verified && report.recovery.verified && report.installation.verified);
    assert(!report.recovery.cpuResetAttempted && report.installation.cpuResetVerified);
    assert.deepEqual(e.fake.memory,plan.expected);assert.deepEqual(e.fake.memory.subarray(131072),e.original.subarray(131072));
    assert.equal(e.fake.resets,1);
  }finally{await e.close();}
});
test('failed restore or cancelled partial restore retains the halted CPU and reports original-backup identity',async()=>{
  for(const mode of ['failure','cancel']){
    const e=await setup(),controller=new AbortController();
    if(mode==='failure')e.fake.ignoreErase=true;
    else e.options.onEvent=name=>{if(name==='recovery_sector_verified')controller.abort();};
    try{
      let error;try{await R.recoverApplication(e.reader,e.original,e.source,{...e.options,apply:true,signal:controller.signal});}catch(e){error=e;}
      assert(error && error.report.cpuKeptHalted && !error.report.cpuResetVerified);
      assert.equal(error.report.backupSha256,e.source.backupSha256);assert.equal(e.fake.resets,0);
    }finally{await e.close();}
  }
});
test('a new application failure rolls back to the verified original instead of the earlier interrupted image',async()=>{
  const e=await setup(),plan=await fixture(e.original),execute=e.fake.executeFlash.bind(e.fake);let damaged=false;
  e.fake.executeFlash=command=>{
    execute(command);
    if(command[0]===2 && command[1]===0 && command[2]===0x1f && command[3]===0xc0 && !damaged){damaged=true;e.fake.memory[0x1001]^=1;}
  };
  try{
    let error;try{await R.restoreAndInstall(e.reader,e.original,e.source,plan.application,{...e.options,apply:true});}catch(e){error=e;}
    assert(error.recoverySession.recovery.verified && error.recoverySession.installation.recoveryVerified);
    assert(error.recoverySession.installation.cpuResetVerified);assert.deepEqual(e.fake.memory,e.original);assert.equal(e.fake.protection,44);
  }finally{await e.close();}
});
test('failed original protection restoration blocks both final reset and new application installation',async()=>{
  const e=await setup(),plan=await fixture(e.original),execute=e.fake.executeFlash.bind(e.fake);
  e.fake.executeFlash=command=>{execute(command);if(command[0]===1&&command[1]===44)e.fake.protection=0;};
  try{
    let error;try{await R.restoreAndInstall(e.reader,e.original,e.source,plan.application,{...e.options,apply:true});}catch(e){error=e;}
    assert(error.recoverySession.recovery.imageVerified && !error.recoverySession.recovery.protectionVerified);
    assert.equal(error.recoverySession.installation,null);assert.equal(e.fake.resets,0);assert.deepEqual(e.fake.memory,e.original);
  }finally{await e.close();}
});
test('changed contents or protection between stages prevent writes and any restart',async()=>{
  for (const mode of ['contents','protection']) {
  const e=await setup(),plan=await fixture(e.original);
  e.options.onEvent=name=>{if(name==='original_protection_verified'){
    if(mode==='contents')e.fake.memory[0x8000]^=1;else e.fake.protection=0x382c;
  }};
  try{
    let error;try{await R.restoreAndInstall(e.reader,e.original,e.source,plan.application,{...e.options,apply:true});}catch(e){error=e;}
    assert.match(error.message,/changed after original-image recovery/);
    assert(error.recoverySession.installation.cpuKeptHalted);assert.equal(e.fake.resets,0);
    assert.deepEqual(e.fake.eraseOrder,[0x3000,0x4000,0x5000,0x6000,0x7000]);
  }finally{await e.close();}
  }
});
