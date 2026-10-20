// Full incident recovery UI against a simulated RP2040; no physical devices.
const {chromium}=require(process.argv[2]||'playwright');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const original=Uint8Array.from({length:524288},(_,i)=>((i>>>8)^i^(i>>>16))&255);
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const proof={apply:true,verified:false,cpuKeptHalted:true,chipId:'026255',jedecId:'eb6013',bridgeVersion:'1.6',applicationBytes:131072,
  protectionOriginal:44,backupSha256:hash(original),flashUidSha256:hash(Uint8Array.from({length:16},(_,i)=>i+1))};
const url=process.env.RECOVERY_URL||'http://127.0.0.1:8778/docs/support/recovery-437-d10-20261020/';
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
  try{
    async function pageFor(mode='happy'){
      const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],requests=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().startsWith('http'))requests.push(r.url());});
      await page.addInitScript({path:__dirname+'/fake-rp2040.js'});
      await page.addInitScript(({proof,mode})=>{
        const fake=window.mockBridge=new FakeRP2040();fake.version=0x10006;fake.allowFlash=true;fake.protection=44;fake.faults=3;
        fake.memory[0x4809]^=1;fake.memory.fill(255,0x5300,0x6000);
        if(mode==='wrong-tag')fake.flashUid[0]^=1;
        if(mode==='factory')fake.memory[0x7e000]^=1;
        let damaged=false;const execute=fake.executeFlash.bind(fake);
        fake.executeFlash=command=>{
          execute(command);
          if(command[0]===2&&command[2]===0x4f&&command[3]===0xc0){
            if(mode==='persistent'||(!damaged&&mode==='happy')){damaged=true;fake.memory[0x4809]^=1;}
            if(mode==='fault')fake.faults++;
          }
          if(mode==='protection'&&command[0]===1&&command[1]===44)fake.protection=0;
        };
        Object.defineProperty(navigator,'usb',{value:{requestDevice:async()=>fake}});
        Object.defineProperty(navigator,'serial',{value:{requestPort:async()=>fake}});
        const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,[5,25,50,60,100].includes(ms)?1:ms,...args);
      },{proof,mode});
      await page.goto(url);
      await page.evaluate(()=>{
        const activate=FirmwareDump.RP2040Reader.prototype.activate,read=FirmwareDump.RP2040Reader.prototype.read;
        FirmwareDump.RP2040Reader.prototype.activate=function(options){return activate.call(this,{...options,activationMs:100});};
        FirmwareDump.RP2040Reader.prototype.read=function(address,...args){if(address===0x0c)throw new Error('Legacy status reply sampling blocked by test');return read.call(this,address,...args);};
      });
      assert(await page.locator('#restore').isDisabled());assert(await page.locator('#connect-usb').isDisabled());
      assert.equal(await page.locator('input[type=file]').count(),2);assert.equal(await page.locator('select').count(),0);
      assert(await page.evaluate(()=>!window.RecoveryFirmware&&!window.D10Firmware));
      async function reportFile(){
        await page.locator('#failure-report').setInputFiles({name:'failed-install.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(proof))});
        await page.waitForFunction(()=>document.getElementById('failure-report-status').textContent.startsWith('Failure report selected'));
      }
      async function connect(){
        await reportFile();
        await page.locator('#backup').setInputFiles({name:'tag-before-D10-test-full.bin',mimeType:'application/octet-stream',buffer:Buffer.from(original)});
        await page.waitForFunction(()=>document.getElementById('backup-status').textContent.startsWith('Correct saved backup'));
        assert(await page.locator('#connect-usb').isDisabled());await page.locator('#reset-disconnected').check();
        await page.locator('#connect-usb').click();await page.waitForFunction(()=>!document.getElementById('connect-serial').disabled);
        await page.locator('#connect-serial').click();await page.waitForFunction(()=>!document.getElementById('check').disabled);
        assert.equal(await page.evaluate(()=>mockBridge.baudRate),460800);
      }
      return {page,errors,requests,connect,reportFile};
    }
    async function clean(c){assert.deepEqual(c.errors,[]);assert(c.requests.every(r=>r===url),'Recovery loaded a companion network resource');await c.page.close();}
    const c=await pageFor(),wrong=Buffer.from(original);wrong[50]^=1;
    await c.page.locator('#backup').setInputFiles({name:'backup.bin',mimeType:'application/octet-stream',buffer:Buffer.from(original)});
    await c.page.waitForFunction(()=>document.getElementById('backup-status').textContent.includes('Choose both'));
    assert(await c.page.locator('#connect-usb').isDisabled());assert.equal(await c.page.evaluate(()=>mockBridge.tx),0);
    await c.page.locator('#failure-report').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"verified":true}')});
    await c.page.waitForFunction(()=>document.getElementById('failure-report-status').textContent.includes('CPU was kept halted'));
    assert(await c.page.locator('#connect-usb').isDisabled());
    await c.reportFile();
    await c.page.locator('#backup').setInputFiles({name:'wrong.bin',mimeType:'application/octet-stream',buffer:wrong});
    await c.page.waitForFunction(()=>document.getElementById('backup-status').textContent.includes('does not match'));
    assert(await c.page.locator('#connect-usb').isDisabled());assert.equal(await c.page.evaluate(()=>mockBridge.tx),0);
    await c.connect();assert(await c.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await c.page.screenshot({path:'/tmp/d10-recovery-ready.png',fullPage:true});
    await c.page.locator('#check').click();await c.page.waitForFunction(()=>document.getElementById('status').textContent==='Checks passed. Ready to restore.',null,{timeout:60000});
    assert.deepEqual(await c.page.evaluate(()=>mockBridge.eraseOrder),[]);assert.deepEqual(await c.page.evaluate(()=>mockBridge.statusWrites),[]);assert.equal(await c.page.evaluate(()=>mockBridge.resets),0);
    await c.page.locator('#restore').click();await c.page.waitForFunction(()=>document.getElementById('status').textContent==='Saved backup restored and verified.',null,{timeout:60000});
    assert.equal(await c.page.evaluate(()=>mockBridge.resets),1);assert.equal(await c.page.evaluate(()=>mockBridge.protection),44);
    assert.equal(hash(Buffer.from(await c.page.evaluate(()=>Array.from(mockBridge.memory)))),hash(original));
    assert.deepEqual(await c.page.evaluate(()=>mockBridge.eraseOrder),[0x4000,0x4000,0x5000]);
    const result=await c.page.evaluate(async()=>JSON.parse(await(await fetch(document.getElementById('report').href)).text()));
    assert(result.verified&&result.cpuResetVerified&&result.nativeStatus);assert.equal(result.sectorWriteLimit,3);assert.equal(result.transport.initialTransportFaults,3);
    assert.equal(result.pageRevision,'2026-10-20.1');assert(await c.page.locator('#restore').isDisabled());
    await c.page.screenshot({path:'/tmp/d10-recovery-complete.png',fullPage:true});await clean(c);
    for(const mode of ['wrong-tag','factory','persistent','fault','protection']){
      const f=await pageFor(mode);await f.connect();await f.page.locator('#check').click();
      await f.page.waitForFunction(()=>['Recovery stopped. Keep the tag powered.','Checks passed. Ready to restore.'].includes(document.getElementById('status').textContent),null,{timeout:60000});
      if(!['wrong-tag','factory'].includes(mode)){
        await f.page.locator('#restore').click();await f.page.waitForFunction(()=>document.getElementById('status').textContent==='Recovery stopped. Keep the tag powered.',null,{timeout:60000});
      }else assert.deepEqual(await f.page.evaluate(()=>mockBridge.eraseOrder),[]);
      assert.equal(await f.page.evaluate(()=>mockBridge.resets),0,mode);assert(await f.page.locator('#restore').isDisabled());
      if(mode==='persistent')assert.deepEqual(await f.page.evaluate(()=>mockBridge.eraseOrder),[0x4000,0x4000,0x4000]);
      if(mode==='fault')assert.deepEqual(await f.page.evaluate(()=>mockBridge.eraseOrder),[0x4000]);
      await clean(f);
    }
    console.log('D10 recovery: exact-backup gate, double-read checks, restore-only UI, checked retries, full verification/reset, fault/identity/factory/protection guards, mobile layout and standalone requests passed.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
