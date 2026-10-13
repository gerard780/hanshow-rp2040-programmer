'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const {SerialIO, USBBridge, RP2040Reader} = FirmwareDump;
  const proof = RecoverySupport.proof, BAUD = 921600;
  let backup = null, included = null, custom = null, ready = false, busy = false, checked = false, completed = false;
  let bridge = null, io = null, controller = null, reportURL = null, started = 0;
  const supported = isSecureContext && !!navigator.usb && !!navigator.serial && !!crypto.subtle;
  const application = () => $('application-mode').value === 'original' ? null : $('application-mode').value === 'custom' ? custom : included;
  const applicationReady = () => $('application-mode').value === 'original' || !!application();
  function log(message) { $('log').textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`; $('log').scrollTop = $('log').scrollHeight; }
  function render() {
    const wire = $('reset-disconnected').checked;
    const canConnect = supported && ready && !!backup && applicationReady() && wire && !busy && !completed;
    $('backup').disabled = busy || !!bridge || completed;
    $('application-mode').disabled = busy || completed;
    $('application-file').disabled = busy || completed;
    $('custom-file').hidden = $('application-mode').value !== 'custom';
    $('reset-disconnected').disabled = busy || !!bridge || !!io || completed;
    $('connect-usb').disabled = !canConnect || !!bridge;
    $('connect-serial').disabled = !canConnect || !bridge || !!io;
    $('disconnect').disabled = busy || (!bridge && !io);
    $('check').disabled = !canConnect || !bridge || !io;
    $('restore').disabled = !canConnect || !bridge || !io || !checked;
    $('cancel').disabled = !controller || controller.signal.aborted;
    $('restore').textContent = $('application-mode').value === 'original' ? 'Restore original firmware' : $('application-mode').value === 'custom' ? 'Restore and install my .bin' : 'Restore and install D9';
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
    $('report').href = reportURL; $('report').download = 'tag-recovery-report.json'; $('result').hidden = false;
  }
  function describeApplication() {
    const mode = $('application-mode').value;
    $('application-status').textContent = mode === 'original' ? 'The original firmware will be restored and restarted.' :
      mode === 'custom' ? custom ? 'Your application file is ready. It will be installed after the original firmware is restored.' : 'Choose the application .bin supplied for this tag.' :
      included ? 'Latest D9 discovery firmware is included and ready.' : 'Checking the included D9 firmware…';
  }
  $('backup').onchange = async () => {
    busy = true; backup = null; checked = false; render();
    try {
      const file = $('backup').files[0];
      if (!file || file.size !== 524288 || !file.name.toLowerCase().endsWith('.bin')) throw new Error('Choose the complete original .bin backup, 512 KiB in size.');
      backup = (await FirmwareRecovery.validateSource(new Uint8Array(await file.arrayBuffer()), proof)).backup;
      $('backup-status').textContent = `Correct original backup selected: ${file.name}`; $('backup-status').className = 'hint ready';
      $('connection-status').textContent = 'Confirm the reset wire is removed, then connect the programmer.';
    } catch (error) { $('backup-status').textContent = error.message; $('backup-status').className = 'hint error'; log(error.message); }
    finally { busy = false; render(); }
  };
  $('application-mode').onchange = () => { checked = false; describeApplication(); render(); };
  $('application-file').onchange = async () => {
    busy = true; checked = false; custom = null; render();
    try {
      const file = $('application-file').files[0];
      if (!file || !file.name.toLowerCase().endsWith('.bin') || file.size > 131072) throw new Error('Choose an application .bin supplied for this tag, up to 128 KiB.');
      custom = (await FirmwareFlash.validateBinary(new Uint8Array(await file.arrayBuffer()))).application;
      describeApplication();
    } catch (error) { $('application-status').textContent = `Application file rejected: ${error.message}`; log(error.message); }
    finally { busy = false; render(); }
  };
  $('reset-disconnected').onchange = render;
  $('connect-usb').onclick = async () => {
    busy = true; checked = false; render();
    try {
      const device = await navigator.usb.requestDevice({filters: [{vendorId: 0xcafe, productId: 0x4012}]});
      if (await FirmwareFlash.digest(new TextEncoder().encode(device.serialNumber || '')) !== proof.programmerSha256) throw new Error('Choose the RP2040 programmer used for your failed installation.');
      bridge = new USBBridge(device); const info = await bridge.open();
      if (info.version !== '1.6') throw new Error('This recovery requires your programmer to run v1.6.');
      $('connection-status').textContent = 'Correct programmer connected. Now click “Choose SWS port”.'; log('Correct RP2040 v1.6 programmer connected.');
    } catch (error) { await disconnect(); $('connection-status').textContent = error.message; log(error.message); }
    finally { busy = false; render(); }
  };
  $('connect-serial').onclick = async () => {
    busy = true; checked = false; render(); let port;
    try {
      port = await navigator.serial.requestPort({filters: [{usbVendorId: 0xcafe, usbProductId: 0x4012}]});
      await port.open({baudRate: BAUD, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 8192});
      await port.setSignals({dataTerminalReady: true, requestToSend: false});
      io = new SerialIO(port); $('connection-status').textContent = 'Programmer connected. Click “Check my tag”.'; log('SWS connection opened at the fixed recovery speed.');
    } catch (error) {
      if (port?.readable && !io) try { await port.close(); } catch (_) {}
      await disconnect(); $('connection-status').textContent = `Connection failed: ${error.message}. Close other flashers and serial monitors before reconnecting.`; log(error.message);
    } finally { busy = false; render(); }
  };
  $('disconnect').onclick = async () => { busy = true; render(); await disconnect(); busy = false; render(); };
  function progress(update) {
    $('progress').max = update.total; $('progress').value = update.done;
    $('status').textContent = `${update.phase}: ${(100 * update.done / update.total).toFixed(0)}%`;
    $('detail').textContent = `${Math.round((performance.now() - started) / 1000)} seconds elapsed. This can take several minutes. Keep this page open and the tag powered.`;
  }
  async function run(apply) {
    if (busy || !bridge || !io || !backup || !applicationReady() || !$('reset-disconnected').checked || (apply && !checked)) return;
    const chosen = application(); busy = true; checked = false; controller = new AbortController(); started = performance.now(); render();
    $('status').textContent = apply ? 'Starting recovery…' : 'Checking your tag…'; $('progress').value = 0;
    let report, failure;
    try {
      report = await FirmwareRecovery.restoreAndInstall(new RP2040Reader(io, bridge, log, BAUD), backup, proof, chosen, {
        apply, resetWireDisconnected: true, signal: controller.signal, progress,
        onEvent: (name, details) => log(`${name.replaceAll('_',' ')}${details.offset === undefined ? '' : ` at 0x${details.offset.toString(16)}`}${details.message ? `: ${details.message}` : ''}`),
      });
      if (!apply && !report.checkPassed) throw new Error('The recovery check did not complete. Save the report.');
      if (apply && !report.verified) throw new Error('Recovery did not verify. Save the report.');
      checked = !apply; completed = apply;
    } catch (error) { failure = error; report = error.recoverySession || report || error.report || {verified: false, error: error.message}; log(error.message); }
    finally {
      if (apply || failure) { const warnings = await disconnect(); if (report) report.connectionCleanupWarnings = warnings; }
      if (report) { report.durationSeconds = (performance.now() - started) / 1000; showReport(report); }
      controller = null; busy = false; render();
    }
    if (failure) {
      if (report?.installation?.recoveryVerified && report.installation.cpuResetVerified) {
        $('status').textContent = 'Original firmware restored. The new application was not installed.';
        $('detail').textContent = `${failure.message} The verified original firmware was restarted. Save this report and send it to Gerard before another installation attempt.`;
      } else {
        $('status').textContent = failure.name === 'AbortError' ? 'Stopped safely. Keep the tag powered.' : 'Recovery stopped. Keep the tag powered.';
        $('detail').textContent = `${failure.message} Save the report below and send it to Gerard. Do not reset or power-cycle the tag.`;
      }
    } else if (!apply) {
      $('status').textContent = 'Checks passed. Ready to recover.';
      $('detail').textContent = 'No firmware was erased or programmed. Click the green button to continue. The tag stays paused until recovery finishes.';
    } else {
      $('status').textContent = chosen ? 'Original firmware restored and new application installed.' : 'Original firmware restored.';
      $('detail').textContent = 'The complete firmware and protection settings were verified, then the tag was restarted. You can reconnect the GP2-to-RST wire. Save the report for Gerard.';
    }
  }
  $('check').onclick = () => run(false); $('restore').onclick = () => run(true);
  $('cancel').onclick = () => { controller?.abort(); $('status').textContent = 'Stopping safely. Keep the tag powered…'; render(); };
  window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
  if (!supported) { $('compatibility').hidden = false; $('compatibility').textContent = 'Open this page in Chrome or Edge on the computer connected to your programmer.'; }
  (async () => {
    try {
      const bytes = Uint8Array.from(atob(RecoveryFirmware.base64), c => c.charCodeAt(0));
      const parsed = await FirmwareFlash.validateBinary(bytes);
      if (parsed.firmwareSha256 !== RecoveryFirmware.sha256 || parsed.firmwareBytes !== RecoveryFirmware.bytes || !parsed.discoveryJournal) throw new Error('The included D9 firmware did not pass its checks. Ask Gerard for a fresh page.');
      included = parsed.application; ready = true; describeApplication(); render();
    } catch (error) { $('application-status').textContent = error.message; $('application-status').className = 'hint error'; log(error.message); render(); }
  })(); render();
})();
