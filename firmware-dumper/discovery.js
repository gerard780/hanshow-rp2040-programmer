/* Read-only 437 Discovery D8/D9 status, UART events and D9 journal decoding.
 * Protocol/layout follow the discovery firmware's controller and journal.h/c.
 */
(function (root) {
  'use strict';
  const flash = typeof module !== 'undefined' && module.exports ? require('./flash.js') : root.FirmwareFlash;
  const UUID = '00001337-0000-1000-8000-00805f9b34fb';
  const STATUS_REQUEST = [0x43, 0x70, 0, 0, 0, 0, 0];
  const STAGES = ['Trial sequence', 'Image A queued', 'Drawing image A', 'Inspect image A', 'Image B queued', 'Drawing image B', 'Inspect image B', 'Confirmed', 'Image A failed', 'Image B failed'];
  const PANEL = ['Idle', 'Reset wait', 'Sensor wait', 'Power wait', 'Refresh wait', 'Power-off wait', 'Electrically complete', 'Error', 'Initialization wait', 'Interpass off wait', 'Interpass delay'];
  const BANKS = ['0ASSPQ0NX', '0BNSPQ0UK', '0BNSPQ069'];
  function decodeStatus(value) {
    const bytes = value instanceof DataView ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : Uint8Array.from(value);
    if (bytes.length !== 20 || bytes[0] !== 0x43 || bytes[1] !== 0xf0 || ![1, 2].includes(bytes[2])) throw new Error('Unsupported discovery status frame; D8/D9 protocol v1/v2 required');
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), flags = bytes[4];
    return {version: bytes[2], result: bytes[3], bank: bytes[5], profile: bytes[6], stage: bytes[7], panelState: bytes[8],
      temperature: d.getInt8(9), band: bytes[10], selectedProfile: bytes[11], attempt: d.getUint32(12, true), nextProfile: bytes[16],
      pattern: bytes[17], waitSeconds: d.getUint16(18, true), running: !!(flags & 1), auto: !!(flags & 2), paused: !!(flags & 4),
      lastSuccess: !!(flags & 8), confirmed: !!(flags & 16), bankMatched: !!(flags & 32), fixedBuild: !!(flags & 64),
      journalHealthy: bytes[2] === 2 ? !!(flags & 128) : null};
  }
  function describeStatus(s) {
    return `Profile ${s.profile < 4 ? 'P' + s.profile : 'unknown'} · attempt ${s.attempt} · ${STAGES[s.stage] || 'stage ' + s.stage} · ${PANEL[s.panelState] || 'panel state ' + s.panelState}`;
  }
  function parseUART(line) {
    let m;
    if ((m = line.match(/N437 D\d+ boot bank=(\d+) fixed=(\d+)/))) return {kind: 'boot', bank: +m[1], fixedProfile: +m[2]};
    if ((m = line.match(/N437 D\d+ start P(\d+) attempt=(\d+) pattern=(\d+)/))) return {kind: 'trial', profile: +m[1], attempt: +m[2], pattern: +m[3]};
    if ((m = line.match(/N437 D\d+ panel=(-?\d+) bank=(\d+) band=(\d+) profile=(\d+) attempt=(\d+)/))) return {kind: 'sensor', temperature: +m[1], bank: +m[2], band: +m[3], profile: +m[4], attempt: +m[5]};
    if ((m = line.match(/N437 D\d+ state=(\d+) pass=(\d+) BUSY=(\d+)/))) return {kind: 'panel', panelState: +m[1], pass: +m[2], busyPin: +m[3]};
    if (/N437 D\d+ sensor failure/.test(line)) return {kind: 'error', message: 'Sensor failure'};
    return null;
  }
  class LineDecoder {
    constructor(onLine) { this.onLine = onLine; this.decoder = new TextDecoder(); this.pending = ''; }
    push(bytes) {
      this.pending += this.decoder.decode(bytes, {stream: true});
      let index;
      while ((index = this.pending.indexOf('\n')) >= 0) { this.onLine(this.pending.slice(0, index).replace(/\r$/, '')); this.pending = this.pending.slice(index + 1); }
      // Bound malformed/no-newline serial traffic while retaining all content.
      while (this.pending.length > 8192) { this.onLine(this.pending.slice(0, 8192)); this.pending = this.pending.slice(8192); }
    }
    finish() { this.pending += this.decoder.decode(); if (this.pending) this.onLine(this.pending.replace(/\r$/, '')); this.pending = ''; }
  }
  class StatusReader {
    constructor(onEvent = () => {}, timeout = 12000) { this.onEvent = onEvent; this.timeout = timeout; this.characteristic = null; this.device = null; this.pending = null; }
    get connected() { return !!this.characteristic; }
    record(kind, details = {}) { try { this.onEvent({time: new Date().toISOString(), kind, ...details}); } catch (_) {} }
    async connect(bluetooth) {
      const device = await bluetooth.requestDevice({acceptAllDevices: true, optionalServices: [UUID]});
      const server = await device.gatt.connect();
      try {
        const service = await server.getPrimaryService(UUID), characteristic = await service.getCharacteristic(UUID);
        await characteristic.startNotifications(); this.attach(characteristic, device);
      } catch (error) { device.gatt.disconnect(); throw error; }
    }
    attach(characteristic, device = null) {
      this.disconnect(); this.characteristic = characteristic; this.device = device;
      this.receive = event => {
        let status;
        try { status = decodeStatus(event.target.value); } catch (error) { this.record('ignored_notification', {message: error.message}); return; }
        this.record('status', {status});
        if (this.pending) { const p = this.pending; this.pending = null; clearTimeout(p.timer); p.resolve(status); }
      };
      characteristic.addEventListener('characteristicvaluechanged', this.receive);
      this.lost = () => this.disconnect(false);
      device?.addEventListener('gattserverdisconnected', this.lost);
      this.record('connected', {name: device?.name || 'Discovery tag'});
    }
    disconnect(closeGatt = true) {
      const c = this.characteristic, d = this.device;
      c?.removeEventListener('characteristicvaluechanged', this.receive);
      d?.removeEventListener('gattserverdisconnected', this.lost);
      this.characteristic = null; this.device = null;
      if (this.pending) { const p = this.pending; this.pending = null; clearTimeout(p.timer); p.reject(new Error('Discovery disconnected')); }
      if (closeGatt && d?.gatt.connected) d.gatt.disconnect();
      if (c) this.record('disconnected');
    }
    async readStatus() {
      if (!this.connected) throw new Error('Connect a discovery tag first');
      if (this.pending) throw new Error('A discovery status read is already pending');
      const c = this.characteristic;
      const response = new Promise((resolve, reject) => { this.pending = {resolve, reject, timer: setTimeout(() => {
        const p = this.pending; this.pending = null;
        if (p) p.reject(new Error('Discovery status timed out; reconnect to read fresh progress'));
        this.disconnect();
      }, this.timeout)}; });
      this.record('status_request');
      try {
        // Race the write as well as the response; late replies cannot cross a
        // timed-out session because timeout removes the notification listener.
        const write = Promise.resolve().then(() => c.writeValueWithoutResponse(Uint8Array.from(STATUS_REQUEST)));
        await Promise.race([write, response]); return await response;
      } catch (error) { this.disconnect(); await response.catch(() => {}); throw error; }
    }
  }
  function decodeJournal(input) {
    const bytes = Uint8Array.from(input);
    const sector = bytes.length === 524288 ? bytes.subarray(0x1f000, 0x20000) : bytes;
    if (sector.length !== 4096) throw new Error('Load a complete 512 KiB readback or 4 KiB D9 journal sector');
    const header = Uint8Array.from(flash.D9_HEADER);
    if (!header.every((b, i) => b === sector[i]) || new DataView(sector.buffer, sector.byteOffset).getUint32(28, true) !== flash.crc32(sector.subarray(0, 28))) throw new Error('No valid D9 discovery journal header');
    const records = [], invalidSlots = [], events = ['', 'Boot', 'Trial start', 'Sensor', 'Panel state', 'Trial end', 'Control', 'Confirmation'];
    let usedSlots = 0;
    for (let slot = 0; slot < 127; slot++) {
      const p = sector.subarray(32 + slot * 32, 64 + slot * 32);
      if (p.every(b => b === 255)) continue;
      usedSlots = slot + 1;
      const d = new DataView(p.buffer, p.byteOffset, p.byteLength);
      if (p[0] !== 0x44 || p[1] !== 0x39 || p[2] !== 0x4c || p[3] !== 0x47 || p[4] !== 1 || p[5] < 1 || p[5] > 7 || !d.getUint32(8, true) || !d.getUint32(12, true) || d.getUint32(28, true) !== flash.crc32(p.subarray(0, 28))) { invalidSlots.push(slot); continue; }
      records.push({slot, event: events[p[5]], eventType: p[5], flags: p[6], bank: p[7], flagNames: ['success','visual_confirmed','bank_matched','fixed','outer_timeout','deadline_timeout','sensor_error','driver_timeout'].filter((_,i)=>p[6] & (1<<i)), sequence: d.getUint32(8, true), session: d.getUint32(12, true),
        attempt: d.getUint32(16, true), uptimeMs: d.getUint32(20, true), profile: p[24], pattern: p[25], stage: p[26], panelState: [3,4,5].includes(p[5]) ? p[26] & 127 : null, pass: [3,4,5].includes(p[5]) ? p[26] >>> 7 : null, temperature: d.getInt8(27)});
    }
    return {address: 0x1f000, capacity: 127, usedSlots, invalidSlots, records};
  }
  const api = {UUID, STAGES, PANEL, BANKS, decodeStatus, describeStatus, parseUART, LineDecoder, StatusReader, decodeJournal};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DiscoveryLog = api;
})(globalThis);
