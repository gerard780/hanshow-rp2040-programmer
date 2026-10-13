// Temporary personal recovery-page tests. No hardware or live user identifiers.
const {chromium}=require(process.argv[2]||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const F=require('../flash.js');
const {fixture}=require('./flash-fixture.cjs');
const original=Uint8Array.from({length:524288},(_,i)=>((i>>>8)^i^(i>>>16))&255);
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const proof={apply:true,verified:false,cpuKeptHalted:true,chipId:'026255',jedecId:'eb6013',bridgeVersion:'1.6',applicationBytes:131072,
  protectionOriginal:44,backupSha256:hash(original),flashUidSha256:hash(Uint8Array.from({length:16},(_,i)=>i+1)),programmerSha256:hash(Buffer.from('FAKE-ZERO'))};
const url=process.env.RECOVERY_URL||'http://127.0.0.1:8769/docs/support/recovery-437-6f3d8a/';
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
  try{
    async function pageFor(options={}){
      const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],requests=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().startsWith('http'))requests.push(r.url());});
      await page.addInitScript({path:__dirname+'/fake-rp2040.js'});
      await page.addInitScript(({proof,options})=>{
        window.mockBridge=new FakeRP2040();window.mockBridge.version=0x10006;window.mockBridge.allowFlash=true;window.mockBridge.protection=0;
        for(const address of [0x3000,0x4000,0x5000,0x6000,0x7000])window.mockBridge.memory[address]^=1;
        if(options.wrongTag)window.mockBridge.flashUid[0]^=1;
        if(options.wrongProgrammer)window.mockBridge.serialNumber='OTHER-PROGRAMMER';
        if(options.failRestore)window.mockBridge.ignoreErase=true;
        if(options.failProtection){const execute=window.mockBridge.executeFlash.bind(window.mockBridge);window.mockBridge.executeFlash=command=>{execute(command);if(command[0]===1&&command[1]===44)window.mockBridge.protection=0;};}
        Object.defineProperty(window,'RecoverySupport',{configurable:true,get:()=>({proof}),set:()=>{}});
        Object.defineProperty(navigator,'usb',{value:{requestDevice:async()=>window.mockBridge}});
        Object.defineProperty(navigator,'serial',{value:{requestPort:async()=>window.mockBridge}});
        const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,[5,25,50,60,100].includes(ms)?1:ms,...args);
      },{proof,options});
      await page.goto(url);
      await page.waitForFunction(()=>document.getElementById('application-status').textContent.includes('included and ready'));
      await page.evaluate(()=>{
        const activate=FirmwareDump.RP2040Reader.prototype.activate;
        FirmwareDump.RP2040Reader.prototype.activate=function(options){return activate.call(this,{...options,activationMs:100});};
      });
      assert(await page.locator('#connect-usb').isDisabled());assert(await page.locator('#restore').isDisabled());
      assert.equal(await page.locator('input[type=file]').count(),2);assert.equal(await page.locator('#application-mode').inputValue(),'d9');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      async function connect(){
        await page.locator('#backup').setInputFiles({name:'original-full.bin',mimeType:'application/octet-stream',buffer:Buffer.from(original)});
        await page.waitForFunction(()=>document.getElementById('backup-status').textContent.startsWith('Correct original backup'));
        assert(await page.locator('#connect-usb').isDisabled());await page.locator('#reset-disconnected').check();
        await page.locator('#connect-usb').click();
        if(options.wrongProgrammer)return;
        await page.waitForFunction(()=>!document.getElementById('connect-serial').disabled);
        await page.locator('#connect-serial').click();await page.waitForFunction(()=>!document.getElementById('check').disabled);
        assert.equal(await page.evaluate(()=>window.mockBridge.baudRate),921600);
      }
      return {page,errors,requests,connect};
    }
    async function clean(c){assert.deepEqual(c.errors,[]);assert(c.requests.every(r=>r===url),'Standalone recovery loaded another network resource');await c.page.close();}
    const d9=await pageFor();
    const wrong=Buffer.from(original);wrong[100]^=1;
    await d9.page.locator('#backup').setInputFiles({name:'wrong-backup.bin',mimeType:'application/octet-stream',buffer:wrong});
    await d9.page.waitForFunction(()=>document.getElementById('backup-status').textContent.includes('does not match'));
    assert(await d9.page.locator('#connect-usb').isDisabled());assert.equal(await d9.page.evaluate(()=>window.mockBridge.tx),0);
    await d9.connect();await d9.page.screenshot({path:'/tmp/recovery-support-mobile.png',fullPage:true});
    await d9.page.locator('#check').click();await d9.page.waitForFunction(()=>document.getElementById('status').textContent==='Checks passed. Ready to recover.',{timeout:60000});
    assert.deepEqual(await d9.page.evaluate(()=>window.mockBridge.eraseOrder),[]);assert.equal(await d9.page.evaluate(()=>window.mockBridge.resets),0);
    const builtin=await d9.page.evaluate(()=>({bytes:Array.from(Uint8Array.from(atob(RecoveryFirmware.base64),c=>c.charCodeAt(0))),sha256:RecoveryFirmware.sha256}));
    assert.equal(hash(Uint8Array.from(builtin.bytes)),builtin.sha256);
    const expected=(await F.prepareFromBinary(Uint8Array.from(builtin.bytes),original)).expected;
    await d9.page.locator('#restore').click();
    await d9.page.waitForFunction(()=>document.getElementById('status').textContent==='Original firmware restored and new application installed.',{timeout:60000});
    assert.equal(await d9.page.evaluate(()=>window.mockBridge.resets),1);assert.equal(await d9.page.evaluate(()=>window.mockBridge.protection),44);
    assert.deepEqual(Uint8Array.from(await d9.page.evaluate(()=>Array.from(window.mockBridge.memory))),expected);
    assert((await d9.page.evaluate(()=>window.mockBridge.signals)).every(s=>s.requestToSend===false));
    const download=d9.page.waitForEvent('download');await d9.page.locator('#report').click();
    const report=JSON.parse(fs.readFileSync(await(await download).path()));assert(report.verified&&report.recovery.verified&&report.installation.verified);
    assert(!report.recovery.cpuResetAttempted&&report.installation.cpuResetVerified);assert(await d9.page.locator('#restore').isDisabled());await clean(d9);

    const restore=await pageFor();await restore.page.locator('#application-mode').selectOption('original');await restore.connect();
    await restore.page.locator('#check').click();await restore.page.waitForFunction(()=>!document.getElementById('restore').disabled,{timeout:60000});
    await restore.page.locator('#restore').click();await restore.page.waitForFunction(()=>document.getElementById('status').textContent==='Original firmware restored.',{timeout:60000});
    assert.deepEqual(Uint8Array.from(await restore.page.evaluate(()=>Array.from(window.mockBridge.memory))),original);await clean(restore);

    const custom=await pageFor();const plan=await fixture(original);await custom.page.locator('#application-mode').selectOption('custom');
    await custom.page.locator('#application-file').setInputFiles({name:'application.bin',mimeType:'application/octet-stream',buffer:Buffer.from(plan.application)});
    await custom.page.waitForFunction(()=>document.getElementById('application-status').textContent.startsWith('Your application file is ready'));
    await custom.connect();await custom.page.locator('#check').click();await custom.page.waitForFunction(()=>!document.getElementById('restore').disabled,{timeout:60000});
    await custom.page.locator('#restore').click();await custom.page.waitForFunction(()=>document.getElementById('status').textContent==='Original firmware restored and new application installed.',{timeout:60000});
    assert.deepEqual(Uint8Array.from(await custom.page.evaluate(()=>Array.from(window.mockBridge.memory))),plan.expected);await clean(custom);

    const wrongProgrammer=await pageFor({wrongProgrammer:true});await wrongProgrammer.connect();
    await wrongProgrammer.page.waitForFunction(()=>document.getElementById('connection-status').textContent.includes('Choose the RP2040 programmer used'));
    assert.equal(await wrongProgrammer.page.evaluate(()=>window.mockBridge.tx),0);await clean(wrongProgrammer);
    const wrongTag=await pageFor({wrongTag:true});await wrongTag.connect();await wrongTag.page.locator('#check').click();
    await wrongTag.page.waitForFunction(()=>document.getElementById('status').textContent==='Recovery stopped. Keep the tag powered.',{timeout:60000});
    assert.deepEqual(await wrongTag.page.evaluate(()=>window.mockBridge.eraseOrder),[]);assert.equal(await wrongTag.page.evaluate(()=>window.mockBridge.resets),0);await clean(wrongTag);
    const failed=await pageFor({failRestore:true});await failed.connect();await failed.page.locator('#check').click();
    await failed.page.waitForFunction(()=>!document.getElementById('restore').disabled,{timeout:60000});await failed.page.locator('#restore').click();
    await failed.page.waitForFunction(()=>document.getElementById('status').textContent==='Recovery stopped. Keep the tag powered.',{timeout:60000});
    assert.equal(await failed.page.evaluate(()=>window.mockBridge.resets),0);assert(await failed.page.locator('#report').isVisible());await clean(failed);
    const protection=await pageFor({failProtection:true});await protection.connect();await protection.page.locator('#check').click();
    await protection.page.waitForFunction(()=>!document.getElementById('restore').disabled,{timeout:60000});await protection.page.locator('#restore').click();
    await protection.page.waitForFunction(()=>document.getElementById('status').textContent==='Recovery stopped. Keep the tag powered.',{timeout:60000});
    assert.equal(await protection.page.evaluate(()=>window.mockBridge.resets),0);
    assert.deepEqual(Uint8Array.from(await protection.page.evaluate(()=>Array.from(window.mockBridge.memory))),original);await clean(protection);
    console.log('Recovery browser checks passed: bound backup/programmer/tag, fixed baud, no reset during checks, original restore, included D9, custom .bin, single final reset, failures, downloadable reports, mobile layout, no external resources.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
