'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const {SerialIO, USBBridge, RP2040Reader, equal} = FirmwareDump;
  const BAUD = 921600;
  const supported = isSecureContext && !!navigator.usb && !!navigator.serial &&
    !!crypto.subtle && typeof window.showSaveFilePicker === 'function';
  let firmware = null, bridge = null, io = null, busy = false, controller = null, completed = false;
  let reportURL = null, started = 0;
  function log(message) {
    $('log').textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
    $('log').scrollTop = $('log').scrollHeight;
  }
  function render() {
    $('connect-usb').disabled = !supported || !firmware || busy || !!bridge || completed;
    $('connect-serial').disabled = !bridge || !!io || busy || completed;
    $('disconnect').disabled = busy || (!bridge && !io);
    $('install').disabled = !supported || !firmware || !bridge || !io || busy || completed;
    $('cancel').disabled = !controller || controller.signal.aborted;
  }
  async function disconnect() {
    const warnings = [];
    if (io) try { await io.close(); } catch (error) { warnings.push(error.message); }
    io = null;
    if (bridge) try { await bridge.close(); } catch (error) { warnings.push(error.message); }
    bridge = null;
    $('usb-status').textContent = 'Programmer disconnected.';
    $('serial-status').textContent = 'Tag port closed.';
    warnings.forEach(message => log(`Connection cleanup: ${message}`));
    return warnings;
  }
  $('connect-usb').onclick = async () => {
    busy = true; $('error').textContent = ''; render();
    try {
      const device = await navigator.usb.requestDevice({filters: [{vendorId: 0xcafe, productId: 0x4012}]});
      bridge = new USBBridge(device);
      const info = await bridge.open();
      if (info.version !== '1.6') throw new Error('Update the RP2040 programmer to v1.6 using the setup guide, then reconnect.');
      $('usb-status').textContent = 'RP2040 v1.6 connected.';
      $('serial-status').textContent = 'Now choose its SWS port.';
      $('status').textContent = 'Next: choose the SWS port.';
    } catch (error) { await disconnect(); $('error').textContent = error.message; log(error.message); }
    finally { busy = false; render(); }
  };
  $('connect-serial').onclick = async () => {
    busy = true; $('error').textContent = ''; render(); let port;
    try {
      port = await navigator.serial.requestPort({filters: [{usbVendorId: 0xcafe, usbProductId: 0x4012}]});
      await port.open({baudRate: BAUD, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 8192});
      await port.setSignals({dataTerminalReady: true, requestToSend: false});
      io = new SerialIO(port);
      $('serial-status').textContent = 'Port open. The programmer/port match will be checked before reading.';
      $('status').textContent = 'Ready to save your backup and install D10.';
    } catch (error) {
      if (port?.readable && !io) try { await port.close(); } catch (_) {}
      $('error').textContent = `Could not open the port: ${error.message}. Close other flashers or serial monitors, then try again.`;
      log(error.message);
    } finally { busy = false; render(); }
  };
  $('disconnect').onclick = async () => {
    busy = true; render(); await disconnect(); busy = false;
    $('status').textContent = 'Start by connecting your programmer.'; render();
  };
  $('cancel').onclick = () => {
    controller?.abort(); $('status').textContent = 'Stopping safely. Keep everything connected while recovery finishes.'; render();
  };
  function progress(update) {
    $('progress').max = update.total; $('progress').value = update.done;
    $('status').textContent = `${update.phase}: ${Math.round(100 * update.done / update.total)}%`;
    $('detail').textContent = `${Math.round((performance.now() - started) / 1000)} seconds elapsed. Keep this page open and the tag powered.`;
  }
  $('install').onclick = async () => {
    if (busy || !firmware || !bridge || !io || completed) return;
    busy = true; $('error').textContent = ''; render();
    let handle;
    try {
      // Must run within this click's activation, before USB/serial work.
      handle = await window.showSaveFilePicker({suggestedName: `tag-before-D10-${Date.now()}-full.bin`,
        types: [{description: 'Complete tag backup', accept: {'application/octet-stream': ['.bin']}}]});
    } catch (error) {
      $('status').textContent = 'No backup location selected. Nothing was installed.';
      if (error.name !== 'AbortError') $('error').textContent = error.message;
      busy = false; render(); return;
    }
    controller = new AbortController(); started = performance.now(); render();
    if (reportURL) { URL.revokeObjectURL(reportURL); reportURL = null; }
    $('result').hidden = true; $('report').removeAttribute('href'); $('after-install').hidden = true;
    $('progress').value = 0; $('status').textContent = 'Checking the tag…';
    let report, failure;
    try {
      report = await FirmwareFlash.installApplication(new RP2040Reader(io, bridge, log, BAUD), firmware, {
        apply: true, saveRecoveryBackup: true, conservative: true, pulseReset: true, activationMs: 3000,
        signal: controller.signal, progress,
        saveBackup: async bytes => {
          // Called after matching full reads and before any unlock/erase/program.
          const bank = await D10Target.validateTarget(bytes, D10Firmware.manifest);
          log(`Supported Nebular 437: ${bank}. Saving backup.`);
          const stream = await handle.createWritable();
          try { await stream.write(bytes); await stream.close(); }
          catch (error) { try { await stream.abort(); } catch (_) {} throw error; }
          const saved = new Uint8Array(await (await handle.getFile()).arrayBuffer());
          if (!equal(saved, bytes)) throw new Error('The saved backup did not verify. No firmware was written.');
          const digest = await FirmwareFlash.digest(saved);
          log(`Backup saved and reread: ${handle.name}; SHA-256 ${digest}.`);
          return digest;
        },
        onEvent: (name, details) => log(`${name.replaceAll('_', ' ')}${details.offset === undefined ? '' : ` at 0x${details.offset.toString(16)}`}${details.message ? `: ${details.message}` : ''}`),
      });
      completed = true;
    } catch (error) { failure = error; report = error.report; log(error.message); }
    finally {
      const warnings = await disconnect();
      if (report) { report.connectionCleanupWarnings = warnings; report.durationSeconds = (performance.now() - started) / 1000; }
      controller = null; busy = false; render();
    }
    if (report) {
      reportURL = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], {type: 'application/json'}));
      $('report').href = reportURL; $('report').download = `D10-install-${Date.now()}-report.json`; $('result').hidden = false;
    }
    if (failure) {
      $('error').textContent = failure.message;
      if (report?.cpuKeptHalted) {
        // Reconnecting would reset a tag whose recovery has not verified.
        completed = true; render();
        $('status').textContent = 'Installation stopped. Keep the tag powered.';
        $('detail').textContent = 'Recovery or protection could not be verified. Keep your saved backup and save the report. Do not reset the tag or retry a normal installation; use the recovery instructions.';
      } else {
        $('status').textContent = report?.recoveryVerified ? 'Stopped safely. Your previous firmware was restored.' : 'D10 was not installed.';
        $('detail').textContent = report?.backupSaved ? `Keep your backup (${handle.name}) and save the report. Reconnect if you want to try again.` : 'No verified backup was saved. Read the error above before reconnecting.';
      }
    } else {
      $('status').textContent = 'D10 installed and verified.';
      $('detail').textContent = `Keep your backup: ${handle.name}. Both programmer connections are closed.`;
      $('progress').max = 1; $('progress').value = 1; $('after-install').hidden = false;
    }
  };
  window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
  if (!supported) {
    $('compatibility').hidden = false;
    $('compatibility').textContent = 'Open this page in desktop Chrome or Edge with USB, serial and file-save access. Use the HTTPS link or localhost.';
  }
  (async () => {
    try {
      const bytes = Uint8Array.from(atob(D10Firmware.base64), c => c.charCodeAt(0));
      const meta = D10Firmware.manifest;
      if (bytes.length !== meta.bytes || await FirmwareFlash.digest(bytes) !== meta.sha256) throw new Error('Included firmware failed its integrity check. Reload the page before connecting.');
      firmware = await FirmwareFlash.validateBinary(bytes);
      if (!firmware.discoveryJournal) throw new Error('Included firmware has no discovery journal. Installation is disabled.');
      $('firmware-status').textContent = 'D10 discovery included · ready';
      log(`Included D10 SHA-256: ${meta.sha256}`);
    } catch (error) { firmware = null; $('firmware-status').textContent = 'Firmware unavailable'; $('error').textContent = error.message; }
    render();
  })();
})();
