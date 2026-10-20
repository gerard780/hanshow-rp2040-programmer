'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const {SerialIO, USBBridge, RP2040Reader} = FirmwareDump;
  const {revision, baudRate} = D10Recovery;
  const supported = isSecureContext && !!navigator.usb && !!navigator.serial && !!crypto.subtle;
  let source = null, backupInput = null, backup = null, busy = false, checked = false, completed = false;
  let bridge = null, io = null, controller = null, reportURL = null, started = 0;
  function log(message) { $('log').textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`; $('log').scrollTop = $('log').scrollHeight; }
  function render() {
    const ready = supported && !!backup && $('reset-disconnected').checked && !busy && !completed;
    $('backup').disabled = busy || !!bridge || completed;
    $('failure-report').disabled = busy || !!bridge || completed;
    $('reset-disconnected').disabled = busy || !!bridge || completed;
    $('connect-usb').disabled = !ready || !!bridge;
    $('connect-serial').disabled = !ready || !bridge || !!io;
    $('disconnect').disabled = busy || (!bridge && !io);
    $('check').disabled = !ready || !bridge || !io;
    $('restore').disabled = !ready || !bridge || !io || !checked;
    $('cancel').disabled = !controller || controller.signal.aborted;
  }
  async function disconnect() {
    const warnings = [];
    if (io) try { await io.close(); } catch (error) { warnings.push(error.message); }
    io = null;
    if (bridge) try { await bridge.close(); } catch (error) { warnings.push(error.message); }
    bridge = null; checked = false;
    $('connection-status').textContent = 'Programmer connections closed.';
    warnings.forEach(message => log(`Connection cleanup: ${message}`)); render(); return warnings;
  }
  function showReport(report) {
    if (reportURL) URL.revokeObjectURL(reportURL);
    reportURL = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], {type: 'application/json'}));
    $('report').href = reportURL; $('report').download = 'd10-recovery-report.json'; $('result').hidden = false;
  }
  async function validateFiles() {
    backup = null;
    if (!source || !backupInput) {
      $('backup-status').textContent = 'Choose both the failed-install report and the complete saved backup.';
      $('backup-status').className = 'hint'; return;
    }
    backup = (await FirmwareRecovery.validateSource(backupInput, source)).backup;
    $('backup-status').textContent = `Correct saved backup selected: ${$('backup').files[0].name}`; $('backup-status').className = 'hint ready';
    $('connection-status').textContent = 'Confirm GP2 is disconnected from RST, then connect the programmer.';
  }
  $('failure-report').onchange = async () => {
    busy = true; source = null; backup = null; checked = false; render();
    $('backup-status').textContent = 'Checking the selected files…'; $('backup-status').className = 'hint';
    try {
      const file = $('failure-report').files[0];
      if (!file || file.size > 1024 * 1024) throw new Error('Choose the failed installer’s JSON report, or a text file containing that complete report.');
      const text = await file.text();
      const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      if (parsed?.apply !== true || parsed.verified !== false || parsed.cpuKeptHalted !== true) throw new Error('Choose the failed installation report that says the CPU was kept halted. An activity log alone is not sufficient.');
      source = parsed;
      $('failure-report-status').textContent = `Failure report selected: ${file.name}`;
      await validateFiles();
    } catch (error) { backup = null; $('failure-report-status').textContent = error.message; log(error.message); }
    finally { busy = false; render(); }
  };
  $('backup').onchange = async () => {
    busy = true; backup = null; checked = false; render();
    backupInput = null;
    $('backup-status').textContent = 'Checking the selected files…'; $('backup-status').className = 'hint';
    try {
      const file = $('backup').files[0];
      if (!file || file.size !== 524288 || !file.name.toLowerCase().endsWith('.bin')) throw new Error('Choose the complete saved .bin backup, 512 KiB in size.');
      backupInput = new Uint8Array(await file.arrayBuffer());
      await validateFiles();
    } catch (error) { $('backup-status').textContent = error.message; $('backup-status').className = 'hint error'; log(error.message); }
    finally { busy = false; render(); }
  };
  $('reset-disconnected').onchange = render;
  $('connect-usb').onclick = async () => {
    busy = true; checked = false; render();
    try {
      const device = await navigator.usb.requestDevice({filters: [{vendorId: 0xcafe, productId: 0x4012}]});
      bridge = new USBBridge(device); const info = await bridge.open();
      if (info.version !== '1.6') throw new Error('This recovery requires programmer v1.6.');
      $('connection-status').textContent = 'Programmer connected. Now click “Choose SWS port”.'; log('RP2040 v1.6 connected.');
    } catch (error) { await disconnect(); $('connection-status').textContent = error.message; log(error.message); }
    finally { busy = false; render(); }
  };
  $('connect-serial').onclick = async () => {
    busy = true; checked = false; render(); let port;
    try {
      port = await navigator.serial.requestPort({filters: [{usbVendorId: 0xcafe, usbProductId: 0x4012}]});
      await port.open({baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 8192});
      await port.setSignals({dataTerminalReady: true, requestToSend: false});
      io = new SerialIO(port); $('connection-status').textContent = 'Connected. Click “Check my tag”.'; log(`SWS opened at ${baudRate} baud.`);
    } catch (error) {
      if (port?.readable && !io) try { await port.close(); } catch (_) {}
      await disconnect(); $('connection-status').textContent = `Connection failed: ${error.message}. Close other flashers and serial monitors before reconnecting.`; log(error.message);
    } finally { busy = false; render(); }
  };
  $('disconnect').onclick = async () => { busy = true; render(); await disconnect(); busy = false; render(); };
  function progress(update) {
    $('progress').max = update.total; $('progress').value = update.done;
    $('status').textContent = `${update.phase}: ${(100 * update.done / update.total).toFixed(0)}%`;
    $('detail').textContent = `${Math.round((performance.now() - started) / 1000)} seconds elapsed. This takes several minutes. Keep this page open and the tag powered.`;
  }
  async function run(apply) {
    if (busy || !bridge || !io || !backup || !$('reset-disconnected').checked || (apply && !checked)) return;
    busy = true; checked = false; controller = new AbortController(); started = performance.now(); render();
    $('status').textContent = apply ? 'Starting restore…' : 'Checking your tag…'; $('progress').value = 0;
    let report, failure;
    try {
      report = await FirmwareRecovery.recoverApplication(new RP2040Reader(io, bridge, log, baudRate), backup, source, {
        apply, resetWireDisconnected: true, nativeStatus: true, sectorWriteAttempts: 3,
        signal: controller.signal, progress,
        onEvent: (name, details) => log(`${name.replaceAll('_',' ')}${details.offset === undefined ? '' : ` at 0x${details.offset.toString(16)}`}${details.attempt ? ` (attempt ${details.attempt}/3)` : ''}${details.message ? `: ${details.message}` : ''}`),
      });
      if (apply ? !report.verified : !report.checkPassed) throw new Error('Recovery did not verify. Save the report.');
      checked = !apply; completed = apply;
    } catch (error) { failure = error; report = error.report || report || {verified: false, error: error.message}; log(error.message); }
    finally {
      if (apply || failure) { const warnings = await disconnect(); if (report) report.connectionCleanupWarnings = warnings; }
      if (report) { report.pageRevision = revision; report.durationSeconds = (performance.now() - started) / 1000; showReport(report); }
      controller = null; busy = false; render();
    }
    if (failure) {
      $('status').textContent = 'Recovery stopped. Keep the tag powered.';
      $('detail').textContent = `${failure.message} Save the report and send it to Gerard. Keep power on and do not reset the tag.`;
    } else if (!apply) {
      $('status').textContent = 'Checks passed. Ready to restore.';
      $('detail').textContent = 'No firmware was erased or programmed. Click “Restore saved backup”. The tag stays paused until recovery finishes.';
    } else {
      $('status').textContent = 'Saved backup restored and verified.';
      $('detail').textContent = 'All 512 KiB and the original protection settings were verified, then the tag was restarted. Save the report. You can reconnect GP2 to RST after this successful restore.';
    }
  }
  $('check').onclick = () => run(false); $('restore').onclick = () => run(true);
  $('cancel').onclick = () => { controller?.abort(); $('status').textContent = 'Stopping safely. Keep the tag powered…'; render(); };
  window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
  if (!supported) { $('compatibility').hidden = false; $('compatibility').textContent = 'Open this page in Chrome or Edge on the computer connected to your programmer.'; }
  log(`D10 recovery revision ${revision} · ${baudRate} baud · native status · up to 3 checked sector-write attempts`);
  render();
})();
