'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const {SerialIO, USBBridge, RP2040Reader, capture, hex, defaultBaud, revision} = FirmwareDump;
  let bridge = null, io = null, controller = null, busy = false, selectedApplication = null, selectedFilename = '';
  let baudRate = 921600;
  let usbLabel = '', serialLabel = '', urls = [], started = 0, phase = '', phaseStarted = 0;
  const supported = isSecureContext && !!navigator.serial && !!navigator.usb && !!crypto.subtle;
  function log(message) {
    $('log').textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
    $('log').scrollTop = $('log').scrollHeight;
  }
  function render() {
    window.DiscoveryUI?.setBusy(busy);
    $('usb').disabled = busy || !supported || !!bridge;
    $('baud').disabled = busy || !!io;
    $('serial').disabled = busy || !bridge || !!io;
    $('disconnect').disabled = busy || (!bridge && !io);
    $('dump').disabled = busy || !bridge || !io;
    $('flash-files').disabled = busy;
    $('flash-confirm').disabled = busy; $('save-backup').disabled = busy;
    const canFlash = supported && (!$('save-backup').checked || !!window.showSaveFilePicker) && !!selectedApplication && !!bridge && !!io && !busy;
    $('flash-check').disabled = !canFlash;
    $('flash').disabled = !canFlash || !$('flash-confirm').checked;
    $('cancel').disabled = !controller || controller.signal.aborted;
    for (const id of ['activation', 'verify', 'reset']) $(id).disabled = busy;
    $('device').textContent = [usbLabel, serialLabel].filter(Boolean).join(' · ') || 'No programmer connected.';
  }
  function clearResult() {
    for (const url of urls) URL.revokeObjectURL(url);
    urls = []; $('result').hidden = true; $('flash-result').hidden = true; $('flash-report').removeAttribute('href'); $('emergency-backup').hidden = true; $('emergency-backup').removeAttribute('href');
    $('binary').removeAttribute('href'); $('report').removeAttribute('href');
  }
  function downloadLink(element, data, name, type) {
    const url = URL.createObjectURL(new Blob([data], {type}));
    urls.push(url); element.href = url; element.download = name;
  }
  async function disconnect() {
    const errors = [];
    if (io) { try { await io.close(); } catch (e) { errors.push(e.message); } }
    io = null; serialLabel = '';
    if (bridge) { try { await bridge.close(); } catch (e) { errors.push(e.message); } }
    bridge = null; usbLabel = ''; render();
    for (const error of errors) log(`Connection cleanup: ${error}`);
    return errors;
  }
  $('usb').onclick = async () => {
    // requestDevice runs directly in the click's user activation.
    busy = true; render();
    try {
      const device = await navigator.usb.requestDevice({filters: [{vendorId: 0xcafe, productId: 0x4012}]});
      bridge = new USBBridge(device);
      const info = await bridge.open();
      $('baud').value = String(defaultBaud(info.version));
      usbLabel = `RP2040 v${info.version} (${device.serialNumber || 'no serial ID'})`;
      log(`Connected ${usbLabel}. Select its SWS serial port next.`);
      $('status').textContent = 'Choose the SWS serial port.';
    } catch (error) {
      log(`USB: ${error.message}`); await disconnect();
      $('status').textContent = 'Programmer not connected.';
    } finally { busy = false; render(); }
  };
  $('serial').onclick = async () => {
    busy = true; render(); let port;
    try {
      port = await navigator.serial.requestPort({filters: [{usbVendorId: 0xcafe, usbProductId: 0x4012}]});
      baudRate = Number($('baud').value);
      await port.open({baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 8192});
      // DTR true enables the bridge SWS engine. RTS false releases reset.
      await port.setSignals({dataTerminalReady: true, requestToSend: false});
      io = new SerialIO(port); serialLabel = `Serial port open at ${baudRate.toLocaleString()} baud`;
      log(`Serial port connected at ${baudRate.toLocaleString()} baud. Its association with this bridge will be checked before capture.`);
      $('status').textContent = 'Ready to dump full flash.';
    } catch (error) {
      log(`Serial: ${error.message}`);
      if (io) { try { await io.close(); } catch (e) { log(e.message); } io = null; }
      else if (port?.readable) { try { await port.close(); } catch (e) { log(e.message); } }
      serialLabel = ''; $('status').textContent = 'Serial connection failed; choose the SWS port again.';
    } finally { busy = false; render(); }
  };
  $('disconnect').onclick = async () => {
    busy = true; render(); await disconnect(); busy = false; render();
    $('status').textContent = 'Disconnected.'; log('Disconnected.');
  };
  $('cancel').onclick = () => {
    controller?.abort(); $('status').textContent = 'Cancelling; completing any active sector and recovering if needed…'; render();
  };
  function progress(update) {
    if (phase !== update.phase) { phase = update.phase; phaseStarted = performance.now(); }
    const elapsed = (performance.now() - phaseStarted) / 1000;
    const remaining = elapsed > 1 ? Math.ceil(elapsed / update.done * (update.total - update.done)) : null;
    $('progress').max = update.total; $('progress').value = update.done;
    $('status').textContent = `${update.phase}: ${(100 * update.done / update.total).toFixed(1)}%`;
    $('detail').textContent = `${update.done.toLocaleString()} / ${update.total.toLocaleString()} bytes · ${Math.round((performance.now() - started) / 1000)}s elapsed${remaining === null ? '' : ` · about ${remaining}s left in this pass`}`;
  }
  $('dump').onclick = async () => {
    const activationMs = Number($('activation').value);
    if (!Number.isInteger(activationMs) || activationMs < 100 || activationMs > 10000) {
      $('status').textContent = 'Choose an activation time from 100 to 10000 ms.'; return;
    }
    busy = true; controller = new AbortController(); clearResult(); render();
    $('progress').value = 0; $('status').textContent = 'Identifying tag and flash…';
    started = performance.now(); phase = '';
    const fullVerify = $('verify').checked;
    log(`Web dumper ${revision}. Starting full-flash backup. Verification: ${fullVerify ? 'two full reads' : 'sample readback'}.`);
    let result = null, failure = null;
    try {
      result = await capture(new RP2040Reader(io, bridge, log, baudRate), {
        signal: controller.signal, activationMs, pulseReset: $('reset').checked, fullVerify, progress,
      });
      const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', result.data)));
      result.metadata.sha256 = digest;
      result.metadata.durationSeconds = (performance.now() - started) / 1000;
      log(`Readback verified. SHA-256: ${digest}`);
      try { window.DiscoveryUI?.inspectJournal(result.data); } catch (_) { /* Ordinary firmware need not contain a D9 journal. */ }
      for (const warning of result.metadata.cleanupWarnings) log(`Tag cleanup: ${warning}`);
    } catch (error) {
      failure = error; log(`${error.name === 'AbortError' ? 'Cancelled' : 'Failed'}: ${error.message}`);
      for (const warning of error.cleanupWarnings || []) log(`Tag cleanup: ${warning}`);
    } finally {
      // Close both handles after every attempt, including disconnect and failure.
      const closeWarnings = await disconnect();
      if (result) result.metadata.connectionCleanupWarnings = closeWarnings;
      controller = null; busy = false; render();
    }
    if (failure) {
      $('status').textContent = failure.name === 'AbortError' ? 'Cancelled. No complete backup created.' : `Backup failed: ${failure.message}`;
      $('detail').textContent = 'Reconnect to try again. If tag cleanup failed, power-cycle the tag to resume its firmware.';
      return;
    }
    const name = `tag-${result.metadata.chipId}-${result.metadata.jedecId}-${result.metadata.started.replace(/[:.]/g, '-')}`;
    downloadLink($('binary'), result.data, `${name}-full.bin`, 'application/octet-stream');
    downloadLink($('report'), JSON.stringify(result.metadata, null, 2) + '\n', `${name}-report.json`, 'application/json');
    $('result').hidden = false;
    const unusual = result.metadata.allZero || result.metadata.allFF;
    const cleanup = result.metadata.cleanupWarnings.length || result.metadata.connectionCleanupWarnings.length;
    $('status').textContent = unusual ? 'Read complete, but the image is entirely 00 or FF.' : 'Full-flash backup ready.';
    $('summary').textContent = `${result.data.length.toLocaleString()} bytes · ${result.metadata.verification}.${unusual ? ' Confirm wiring and compare another capture before relying on this image.' : ''}`;
    $('hash').textContent = `SHA-256: ${result.metadata.sha256}`;
    $('detail').textContent = cleanup ? 'Readback passed, but cleanup reported an error. Check the activity log and power-cycle the tag.' : 'The tag was reset and both connections were closed. Save the binary and its report.';
  };
  if (window.DiscoveryUI) window.DiscoveryUI.swsPort = () => io?.port;
  $('flash-confirm').onchange = render;
  $('save-backup').onchange = render;
  $('flash-files').onchange = async () => {
    selectedApplication = null; selectedFilename = ''; $('flash-confirm').checked = false;
    busy = true; render();
    try {
      const files = $('flash-files').files;
      if (files.length !== 1) throw new Error('Select one application .bin file.');
      const file = files[0];
      if (!file.name.toLowerCase().endsWith('.bin') || file.size > 131072) throw new Error('Select an application .bin up to 131072 bytes. Full tag dumps and UF2 files are not supported.');
      selectedApplication = await FirmwareFlash.validateBinary(new Uint8Array(await file.arrayBuffer()));
      selectedFilename = file.name;
      $('plan-status').textContent = `Firmware validated: ${file.name} · ${selectedApplication.firmwareBytes.toLocaleString()} bytes. A plan for this tag will be built automatically from two fresh matching reads.`;
      log(`Application checksum and size verified. SHA-256: ${selectedApplication.firmwareSha256}`);
      if (selectedApplication.discoveryJournal) log('D9 journal descriptor recognized. Existing valid-header journal bytes will be preserved, or a new journal initialized in the reserved application sector.');
    } catch (error) { $('plan-status').textContent = `Firmware rejected: ${error.message}`; log(error.message); }
    finally { busy = false; render(); }
  };
  async function flashApplication(apply) {
    if (!selectedApplication || !bridge || !io || (apply && !$('flash-confirm').checked)) return;
    const activationMs = Number($('activation').value);
    if (!Number.isInteger(activationMs) || activationMs < 100 || activationMs > 10000) {
      $('status').textContent = 'Choose an activation time from 100 to 10000 ms.'; return;
    }
    // Saving is optional. When enabled, the file chooser must execute during
    // this click's user activation, before USB work.
    const saveRecoveryBackup = $('save-backup').checked;
    let handle; busy = true; render();
    if (saveRecoveryBackup) {
      try {
        handle = await window.showSaveFilePicker({suggestedName: `tag-recovery-${Date.now()}-full.bin`,
          types: [{description: 'Complete tag recovery backup', accept: {'application/octet-stream': ['.bin']}}]});
      } catch (error) { log(`Backup file not selected: ${error.message}`); busy = false; render(); return; }
      if (handle.name === selectedFilename) {
        log('Choose a separate recovery backup file; retain your firmware .bin.'); busy = false; render(); return;
      }
    }
    busy = true; controller = new AbortController(); render(); clearResult();
    $('flash-result').hidden = true; $('flash-report').removeAttribute('href');
    started = performance.now(); phase = ''; $('progress').value = 0;
    log(`${apply ? 'Installing' : 'Checking'} ${selectedFilename} with web tool ${revision}. Recovery backup: ${handle ? handle.name : 'not saved; memory only'}.`);
    let report, failure, emergencyBackup;
    try {
      report = await FirmwareFlash.installApplication(new RP2040Reader(io, bridge, log, baudRate), selectedApplication, {
        apply, saveRecoveryBackup, activationMs, pulseReset: $('reset').checked, signal: controller.signal, progress,
        saveBackup: async (bytes, details) => {
          const stream = await handle.createWritable();
          try { await stream.write(bytes); await stream.close(); }
          catch (error) { try { await stream.abort(); } catch (_) {} throw error; }
          const saved = new Uint8Array(await (await handle.getFile()).arrayBuffer());
          const hash = await FirmwareFlash.digest(saved);
          if (!equalBytes(saved, bytes)) throw new Error('Saved recovery backup differs; writes refused');
          log(`Recovery backup saved and reread: ${handle.name}, SHA-256 ${hash}.`);
          return hash;
        },
        onEvent: (name, details) => log(`${name.replaceAll('_', ' ')}${details.offset === undefined ? '' : ` at 0x${details.offset.toString(16)}`}${details.message ? `: ${details.message}` : ''}`),
      });
    } catch (error) { failure = error; report = error.report; emergencyBackup = error.recoveryBackup; log(`Application operation failed: ${error.message}`); }
    finally {
      const warnings = await disconnect();
      if (report) { report.connectionCleanupWarnings = warnings; report.durationSeconds = (performance.now() - started) / 1000; }
      controller = null; busy = false; $('flash-confirm').checked = false; render();
    }
    if (report) {
      downloadLink($('flash-report'), JSON.stringify(report, null, 2) + '\n', `tag-flash-${Date.now()}-report.json`, 'application/json');
      $('flash-result').hidden = false;
      if (emergencyBackup) { downloadLink($('emergency-backup'), emergencyBackup, `tag-emergency-recovery-${Date.now()}-full.bin`, 'application/octet-stream'); $('emergency-backup').hidden = false; }
    }
    if (failure) {
      $('status').textContent = `Application operation failed: ${failure.message}`;
      $('flash-summary').textContent = report?.recoveryVerified ? 'Original application restored and protection verified; installation was cancelled or failed.' : (report?.backupSaved ? 'Operation failed. Keep the recovery backup and this report.' : 'Operation failed without a saved recovery file. Retain this report and any offered emergency backup.');
      $('detail').textContent = report?.cpuKeptHalted ? (report?.backupSaved ? 'CPU kept halted: recovery or protection failed. Keep power connected and use your saved same-tag backup to recover before resetting.' : 'CPU kept halted: recovery or protection failed. Keep this page and power connected; download the emergency recovery backup before resetting or closing the page.') : 'See the activity log and downloaded report. Reconnect for another attempt.';
    } else {
      $('status').textContent = apply ? (report.alreadyInstalled ? 'Application already installed; no writes needed.' : 'Application installed and verified.') : 'Firmware and tag reads verified; no application writes performed.';
      $('flash-summary').textContent = `${handle ? `Recovery backup: ${handle.name}.` : 'Recovery backup was not saved; original bytes were held only for this session.'} Protection and CPU reset verified.`;
      $('detail').textContent = 'Both connections closed. Save the flashing report.';
    }
  }
  function equalBytes(a, b) { return a.length === b.length && a.every((byte, index) => byte === b[index]); }
  $('flash-check').onclick = () => flashApplication(false);
  $('flash').onclick = () => flashApplication(true);
  if (!window.showSaveFilePicker) { $('save-backup').checked = false; $('backup-option-detail').textContent = 'File-save access is unavailable. Flashing can proceed without a saved backup; original bytes are held only for this session.'; }
  $('save-log').onclick = () => {
    const url = URL.createObjectURL(new Blob([$('log').textContent], {type: 'text/plain'}));
    const link = document.createElement('a'); link.href = url; link.download = 'tag-backup-log.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
  if (!supported) {
    $('compatibility').hidden = false;
    $('compatibility').textContent = 'Open this page in desktop Chrome or Edge using HTTPS or localhost. This browser/context does not provide the required USB, serial and checksum APIs.';
  }
  render();
})();
