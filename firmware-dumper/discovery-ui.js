/* Discovery readers are independent of the SWS flasher; no control mutations. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const D = root.DiscoveryLog;
  let busy = false, externalBusy = false, uartPort = null, uartReader = null, uartTask = null, uartStopping = false;
  const session = {schema: 'nebular-discovery-log-v1', started: new Date().toISOString(), events: [], droppedEvents: 0, journal: null};
  let eventChars = 0;
  function record(event) {
    event = {time: new Date().toISOString(), ...event};
    const size = JSON.stringify(event).length;
    session.events.push(event); eventChars += size;
    while (session.events.length > 2000 || eventChars > 2097152) { eventChars -= JSON.stringify(session.events.shift()).length; session.droppedEvents++; }
    $('discovery-log').textContent = session.events.slice(-100).map(e => `${e.time.slice(11, 19)} ${e.kind}: ${e.line || e.message || (e.status ? D.describeStatus(e.status) : e.name || '')}`).join('\n');
    $('discovery-log').scrollTop = $('discovery-log').scrollHeight;
  }
  const reader = new D.StatusReader(event => {
    record(event);
    if (event.kind === 'status') {
      const s = event.status;
      $('discovery-status').textContent = s.result ? `Firmware status error ${s.result}` : D.describeStatus(s);
      $('discovery-detail').textContent = `${s.bankMatched ? D.BANKS[s.bank] || 'Bank ' + s.bank : 'Bank unrecognized'} · ${s.band === 255 ? 'Temperature not sampled' : s.temperature + ' °C'} · ${s.fixedBuild ? 'Fixed profile' : s.paused ? 'Paused' : s.auto ? 'Automatic' : 'Manual'} · next ${s.nextProfile < 4 ? 'P' + s.nextProfile : 'none'} · wait ${s.waitSeconds}s · ${s.version === 2 ? (s.journalHealthy ? 'Journal recording' : 'Journal full, absent or write fault') : 'D8: no journal flag'}. ${s.confirmed ? 'Firmware reports explicit profile confirmation.' : 'Electrical completion is not visual display confirmation.'}`;
      session.lastStatus = s;
    }
    if (event.kind === 'connected') { session.lastStatus = null; $('discovery-status').textContent = 'Discovery connected. Waiting for fresh status…'; $('discovery-detail').textContent = 'Reading firmware status; inspect the physical display separately.'; }
    if (event.kind === 'disconnected') { session.lastStatus = null; $('discovery-status').textContent = 'Discovery disconnected. The tag may continue its trials.'; }
    render();
  });
  function render() {
    $('discovery-connect').disabled = busy || externalBusy || reader.connected || !isSecureContext || !navigator.bluetooth;
    $('discovery-read').disabled = busy || externalBusy || !reader.connected || !!reader.pending;
    $('discovery-disconnect').disabled = busy || externalBusy || !reader.connected;
    $('uart-connect').disabled = busy || externalBusy || !!uartPort || !isSecureContext || !navigator.serial;
    $('uart-stop').disabled = busy || externalBusy || !uartPort;
    $('uart-baud').disabled = busy || externalBusy || !!uartPort;
    $('discovery-file').disabled = externalBusy;
  }
  async function readStatus() {
    if (busy || externalBusy || !reader.connected || reader.pending) return;
    busy = true; render();
    try { await reader.readStatus(); }
    catch (error) { record({kind: 'error', message: error.message}); $('discovery-status').textContent = `Status read failed: ${error.message}`; }
    finally { busy = false; render(); }
  }
  $('discovery-connect').onclick = async () => {
    busy = true; render();
    try { await reader.connect(navigator.bluetooth); }
    catch (error) { record({kind: 'error', message: error.message}); $('discovery-status').textContent = `Discovery connection failed: ${error.message}`; }
    finally { busy = false; render(); }
    if (reader.connected) await readStatus();
  };
  $('discovery-read').onclick = readStatus;
  $('discovery-disconnect').onclick = () => { reader.disconnect(); render(); };
  const polling = setInterval(() => { if ($('discovery-poll').checked) readStatus(); }, 5000);
  function uartLine(line) {
    const parsed = D.parseUART(line); record({kind: 'uart', line, parsed});
    if (parsed?.kind === 'trial') $('uart-status').textContent = `Discovery trial P${parsed.profile}, attempt ${parsed.attempt}, pattern ${parsed.pattern}`;
    else if (parsed?.kind === 'panel') $('uart-status').textContent = `${D.PANEL[parsed.panelState] || 'Panel state ' + parsed.panelState} · pass ${parsed.pass} · BUSY pin ${parsed.busyPin}`;
    else if (parsed?.kind === 'boot') $('uart-status').textContent = `Discovery boot · bank ${parsed.bank} · ${parsed.fixedProfile < 4 ? 'fixed P' + parsed.fixedProfile : 'automatic trials'}`;
    else if (parsed?.kind === 'error') $('uart-status').textContent = parsed.message;
  }
  $('uart-connect').onclick = async () => {
    busy = true; render(); let port;
    try {
      port = await navigator.serial.requestPort({filters: [{usbVendorId: 0xcafe, usbProductId: 0x4012}]});
      if (root.DiscoveryUI?.swsPort?.() === port) throw new Error('Choose the Tag UART / if02 port, not the open SWS port');
      const baudRate = Number($('uart-baud').value);
      await port.open({baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 4096});
      // Enables only the UART receiver when if02 is selected; RTS remains low.
      await port.setSignals({dataTerminalReady: true, requestToSend: false});
      uartPort = port; uartStopping = false; uartReader = port.readable.getReader();
      const lineDecoder = new D.LineDecoder(uartLine);
      $('uart-status').textContent = `Listening at ${baudRate.toLocaleString()} baud. Waiting for tag output…`;
      record({kind: 'uart_connected', message: `${baudRate} baud`});
      uartTask = (async () => {
        try {
          while (!uartStopping) { const {value, done} = await uartReader.read(); if (done) break; if (value) lineDecoder.push(value); }
        } catch (error) { if (!uartStopping) record({kind: 'uart_error', message: error.message}); }
        finally {
          lineDecoder.finish(); uartReader.releaseLock(); uartReader = null;
          if (!uartStopping) {
            try { await port.close(); } catch (_) {}
            uartPort = null; $('uart-status').textContent = 'UART disconnected.'; render();
          }
        }
      })();
    } catch (error) {
      record({kind: 'uart_error', message: error.message}); $('uart-status').textContent = error.message;
      if (port?.readable && port !== uartPort && root.DiscoveryUI?.swsPort?.() !== port) { try { await port.close(); } catch (_) {} }
    } finally { busy = false; render(); }
  };
  async function stopUART() {
    if (!uartPort) return;
    const port = uartPort; uartStopping = true;
    try { if (uartReader) await uartReader.cancel(); await uartTask; await port.setSignals({dataTerminalReady: false, requestToSend: false}); await port.close(); }
    catch (error) { record({kind: 'uart_error', message: error.message}); }
    finally { uartPort = null; uartReader = null; uartTask = null; $('uart-status').textContent = 'UART stopped.'; render(); }
  }
  $('uart-stop').onclick = async () => { busy = true; render(); await stopUART(); busy = false; render(); };
  function inspectJournal(bytes, source = 'Current full readback') {
    const journal = D.decodeJournal(bytes); session.journal = {source, ...journal};
    $('journal-status').textContent = `${journal.records.length} valid events · ${journal.usedSlots}/${journal.capacity} occupied slots · ${journal.invalidSlots.length} invalid/torn slots.`;
    $('journal-log').textContent = journal.records.map(r => `#${r.sequence} session ${r.session} +${(r.uptimeMs / 1000).toFixed(3)}s ${r.event} P${r.profile} attempt=${r.attempt} pattern=${r.pattern} ${r.panelState === null ? `operation/stage=${r.stage}` : `${D.PANEL[r.panelState] || r.panelState} pass=${r.pass}`} temp=${r.temperature} flags=${r.flagNames.join(",") || "none"}`).join('\n') || 'Journal header valid; no recorded events.';
    record({kind: 'journal_loaded', message: `${source}: ${journal.records.length} verified records`}); return journal;
  }
  $('discovery-file').onchange = async () => {
    try {
      const file = $('discovery-file').files[0]; if (!file) return;
      session.journal = null; $('journal-log').textContent = '';
      if (![4096, 524288].includes(file.size)) throw new Error('Choose a full 512 KiB backup or 4 KiB D9 journal sector');
      inspectJournal(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (error) { $('journal-status').textContent = error.message; record({kind: 'journal_error', message: error.message}); }
  };
  $('discovery-save').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(session, null, 2) + '\n'], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = `discovery-session-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('discovery-clear').onclick = () => { session.events = []; eventChars = 0; session.droppedEvents = 0; session.journal = null; $('discovery-log').textContent = ''; $('journal-log').textContent = ''; $('journal-status').textContent = 'No discovery journal loaded.'; };
  if (!navigator.bluetooth) $('discovery-status').textContent = 'Web Bluetooth is unavailable here. UART and saved-journal decoding can still be used.';
  root.DiscoveryUI = {setBusy: value => { externalBusy = value; render(); }, inspectJournal, swsPort: null};
  window.addEventListener('pagehide', () => { clearInterval(polling); reader.disconnect(); stopUART(); }); render();
})(globalThis);
