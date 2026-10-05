'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const {SerialIO, USBBridge, RP2040Reader, capture, hex, defaultBaud, revision, CH340Reader, ch340Filters, isCH340} = FirmwareDump;
  let bridge = null, io = null, controller = null, busy = false;
  let baudRate = 921600;
  let usbLabel = '', serialLabel = '', urls = [], started = 0, phase = '', phaseStarted = 0;
  const supported = isSecureContext && !!navigator.serial && !!crypto.subtle;
  function log(message) {
    $('log').textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
    $('log').scrollTop = $('log').scrollHeight;
  }
  const usesCH340 = () => $('adapter').value === 'ch340';
  function render() {
    const ch340 = usesCH340();
    $('adapter').disabled = busy || !!bridge || !!io;
    $('rp2040-guide').hidden = ch340; $('ch340-guide').hidden = !ch340;
    $('connection-help').textContent = ch340
      ? 'Choose your CH340/CH341 USB serial port. Close other flashers and serial monitors first.'
      : 'Choose the RP2040, then its SWS readback serial port (first interface / if00). Close other flashers and serial monitors first.';
    $('usb').hidden = ch340;
    $('usb').disabled = busy || !supported || !navigator.usb || !!bridge;
    $('baud').disabled = busy || !!io || ch340;
    $('serial').textContent = ch340 ? 'Choose CH340 port' : 'Choose SWS port';
    $('serial').disabled = busy || !supported || (!ch340 && !bridge) || !!io;
    $('disconnect').disabled = busy || (!bridge && !io);
    $('dump').disabled = busy || (!usesCH340() && !bridge) || !io;
    $('cancel').disabled = !controller || controller.signal.aborted;
    for (const id of ['activation', 'verify', 'reset']) $(id).disabled = busy;
    $('device').textContent = [usbLabel, serialLabel].filter(Boolean).join(' · ') || 'No programmer connected.';
    $('reset-label').textContent = ch340 ? 'Pulse RTS to reset the tag (only with RTS wired to RST)' : 'Use GP2 to reset the tag before capture';
    $('speed-help').textContent = ch340
      ? 'CH340 uses UART samples at 921600 baud, one request per byte. Full backups take longer than the RP2040’s native block reads.'
      : 'The v1.4/v1.5 bridge defaults to 2 Mbaud. Previous Python bench reads took about 30 seconds per 512 KiB pass; browser timing may differ. If verification fails, reconnect and select 1.5 Mbaud before choosing the serial port.';
  }
  function clearResult() {
    for (const url of urls) URL.revokeObjectURL(url);
    urls = []; $('result').hidden = true;
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
  $('adapter').onchange = () => {
    $('baud').value = '921600';
    $('reset').checked = !usesCH340();
    clearResult(); render();
    $('status').textContent = usesCH340() ? 'Choose the CH340 serial port.' : 'Choose the RP2040 programmer.';
  };
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
      const ch340 = usesCH340();
      port = await navigator.serial.requestPort({filters: ch340 ? ch340Filters : [{usbVendorId: 0xcafe, usbProductId: 0x4012}]});
      if (ch340 && !isCH340(port.getInfo())) throw new Error('Select a CH340/CH341 USB serial adapter');
      baudRate = ch340 ? 921600 : Number($('baud').value);
      await port.open({baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 8192});
      // RP2040 uses DTR for its SWS engine; CH340 leaves modem lines released.
      await port.setSignals({dataTerminalReady: !ch340, requestToSend: false});
      io = new SerialIO(port); io.chunkEcho = ch340; serialLabel = `${ch340 ? 'CH340' : 'SWS'} serial port open at ${baudRate.toLocaleString()} baud`;
      log(ch340 ? 'CH340 serial port connected at 921600 baud. SWS echo, chip ID and flash size will be checked before capture.' : `Serial port connected at ${baudRate.toLocaleString()} baud. Its association with this bridge will be checked before capture.`);
      $('status').textContent = 'Ready to dump full flash.';
    } catch (error) {
      log(`Serial: ${error.message}`);
      if (io) { try { await io.close(); } catch (e) { log(e.message); } io = null; }
      else if (port?.readable) { try { await port.close(); } catch (e) { log(e.message); } }
      serialLabel = ''; $('status').textContent = 'Serial connection failed; choose the adapter’s serial port again.';
    } finally { busy = false; render(); }
  };
  $('disconnect').onclick = async () => {
    busy = true; render(); await disconnect(); busy = false; render();
    $('status').textContent = 'Disconnected.'; log('Disconnected.');
  };
  $('cancel').onclick = () => {
    controller?.abort(); $('status').textContent = 'Cancelling and releasing the tag…'; render();
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
      const reader = usesCH340() ? new CH340Reader(io, log) : new RP2040Reader(io, bridge, log, baudRate);
      result = await capture(reader, {
        signal: controller.signal, activationMs, pulseReset: $('reset').checked, fullVerify, progress,
      });
      const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', result.data)));
      result.metadata.sha256 = digest;
      result.metadata.durationSeconds = (performance.now() - started) / 1000;
      log(`Readback verified. SHA-256: ${digest}`);
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
  $('save-log').onclick = () => {
    const url = URL.createObjectURL(new Blob([$('log').textContent], {type: 'text/plain'}));
    const link = document.createElement('a'); link.href = url; link.download = 'tag-backup-log.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
  if (!supported) {
    $('compatibility').hidden = false;
    $('compatibility').textContent = 'Open this page in desktop Chrome or Edge using HTTPS or localhost. This browser/context does not provide the required serial and checksum APIs. RP2040 mode also requires WebUSB.';
  }
  render();
})();
