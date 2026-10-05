/* UART/SWS readback, independently implemented from pvvx/TlsrComSwireWriter.
 * See README.md for protocol provenance and supported hardware.
 * This module has no flash erase, program, unlock, or status-write operation.
 */
(function (root) {
  'use strict';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  function check(signal) {
    if (signal?.aborted) throw new DOMException('Dump cancelled', 'AbortError');
  }
  function encode(values) {
    const out = new Uint8Array(values.length * 10);
    values.forEach((value, i) => {
      out[i * 10] = i === 0 ? 0x80 : 0xfe;
      for (let bit = 0; bit < 8; bit++) out[i * 10 + bit + 1] = value & (0x80 >> bit) ? 0x80 : 0xfe;
      out[i * 10 + 9] = 0xfe;
    });
    return out;
  }
  const stop = () => encode([0xff]);
  const header = (address, mode) => [0x5a, (address >> 16) & 255, (address >> 8) & 255, address & 255, mode];
  function writePacket(address, data) {
    const body = encode([...header(address, 0), ...data]);
    const out = new Uint8Array(body.length + 10);
    out.set(body); out.set(stop(), body.length);
    return out;
  }
  function decode(bytes) {
    if (bytes.length !== 9 || (bytes[8] & 0xfe) !== 0xfe) throw new Error('Invalid SWS reply');
    let value = 0;
    for (let i = 0; i < 8; i++) value = (value << 1) | ((bytes[i] & (i === 0 ? 0x20 : 0x10)) === 0 ? 1 : 0);
    return value;
  }
  async function bounded(promise, timeout, message) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
      })]);
    } finally { clearTimeout(timer); }
  }

  // One persistent reader: timed reads never leave orphaned reader.read() calls.
  class SerialIO {
    constructor(port, timeout = 1500) {
      this.port = port; this.timeout = timeout;
      this.reader = port.readable.getReader();
      this.writer = port.writable.getWriter();
      this.queue = []; this.available = 0; this.waiter = null;
      this.error = null; this.closing = false;
      this.pumpTask = this.pump();
    }
    wake() { if (this.waiter) { const wake = this.waiter; this.waiter = null; wake(); } }
    async pump() {
      try {
        while (!this.closing) {
          const {value, done} = await this.reader.read();
          if (done) break;
          if (value?.length) {
            this.queue.push(value); this.available += value.length;
            if (this.available > 65536) throw new Error('Unexpected serial traffic; receive buffer overflow');
            this.wake();
          }
        }
        if (!this.closing) this.error = new Error('Serial device disconnected');
      } catch (error) { this.error = error; }
      finally { this.reader.releaseLock(); this.readerReleased = true; this.wake(); }
    }
    clear() { this.queue = []; this.available = 0; }
    async settle() { await sleep(25); this.clear(); }
    async readExactly(count, timeout = this.timeout) {
      const deadline = performance.now() + timeout;
      while (this.available < count) {
        if (this.error) throw this.error;
        if (this.closing) throw new Error('Serial port is closing');
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error(`Serial timeout (${this.available}/${count} bytes); check RX → SWS wiring`);
        let timer;
        await new Promise(resolve => {
          const wake = () => { clearTimeout(timer); if (this.waiter === wake) this.waiter = null; resolve(); };
          this.waiter = wake; timer = setTimeout(wake, remaining);
        });
      }
      if (this.error) throw this.error;
      const out = new Uint8Array(count);
      let offset = 0;
      while (offset < count) {
        const first = this.queue[0], take = Math.min(first.length, count - offset);
        out.set(first.subarray(0, take), offset); offset += take; this.available -= take;
        if (take === first.length) this.queue.shift(); else this.queue[0] = first.subarray(take);
      }
      return out;
    }
    async send(bytes, echo = true) {
      if (this.error) throw this.error;
      // Keep entire 10-byte SWS words within 60-byte CH340 USB transfers.
      for (let offset = 0; offset < bytes.length; offset += 60) {
        try {
          await bounded(this.writer.write(bytes.subarray(offset, offset + 60)), 2000, 'Serial write timed out');
        } catch (error) { this.error = error; throw error; }
      }
      if (echo && !equal(await this.readExactly(bytes.length), bytes)) throw new Error('Serial echo mismatch; check wiring and baud rate');
    }
    async close() {
      this.closing = true; this.wake();
      const errors = [];
      if (!this.readerReleased) {
        try { await bounded(this.reader.cancel(), 2000, 'Serial reader did not stop'); } catch (e) { errors.push(e.message); }
      }
      try { await bounded(this.pumpTask, 2000, 'Serial reader lock was not released'); } catch (e) { errors.push(e.message); }
      try { this.writer.releaseLock(); } catch (e) { errors.push(e.message); }
      try { await bounded(this.port.close(), 3000, 'Serial port did not close; unplug the adapter'); } catch (e) { errors.push(e.message); }
      if (errors.length) throw new Error(errors.join('; '));
    }
  }

  // Explicit capacities from the bundled Telink chip_8258 flash_type.h.
  // Unknown IDs are rejected rather than guessing the size of a complete backup.
  const flashSizes = Object.freeze({
    'eb6013': 524288, 'c86013': 524288, '856013': 524288,
    '5e3213': 524288, '514013': 524288,
    'c86014': 1048576, '5e3214': 1048576, 'c86010': 65536,
  });
  function flashSize(jedec) {
    const size = flashSizes[hex(jedec)];
    if (!size) throw new Error(`Unsupported flash JEDEC ID ${hex(jedec)}; full flash size cannot be confirmed`);
    return size;
  }

  class Reader {
    constructor(io, log = () => {}) { this.io = io; this.log = log; }
    reg(address, data) { return this.io.send(writePacket(address, data)); }
    async read(address, count, signal) {
      await sleep(50); this.io.clear();
      await this.io.send(encode(header(address, 0x80)));
      const out = new Uint8Array(count);
      try {
        for (let i = 0; i < count; i++) {
          check(signal);
          await this.io.send(Uint8Array.of(0xfe), false);
          out[i] = decode(await this.io.readExactly(9));
        }
      } finally {
        // Finish the active transaction even when the user cancels mid-byte.
        await this.io.settle();
        await this.io.send(stop());
      }
      return out;
    }
    async activate({activationMs = 3000, pulseReset = false, signal} = {}) {
      if (!Number.isInteger(activationMs) || activationMs < 100 || activationMs > 10000) throw new Error('Activation must be 100–10000 ms');
      check(signal);
      if (pulseReset) {
        await this.io.port.setSignals({dataTerminalReady: true, requestToSend: true});
        await sleep(100);
        await this.io.port.setSignals({dataTerminalReady: false, requestToSend: false});
      }
      this.log('Stopping the CPU and calibrating SWS…');
      await this.io.send(writePacket(0x6f, [0x20]), false);
      const deadline = performance.now() + activationMs;
      while (performance.now() < deadline) {
        check(signal);
        for (let i = 0; i < 5; i++) await this.io.send(writePacket(0x602, [5]), false);
        this.io.clear();
        // Bound queued UART data before sending another stop burst.
        await sleep(5);
      }
      await this.io.settle(); await this.io.send(stop()); await this.reg(0x602, [5]);
      for (let divisor = Math.round(32000000 / 921600); divisor <= Math.round(96000000 / 921600); divisor++) {
        check(signal); await this.io.settle();
        await this.reg(0xb2, [divisor]);
        try {
          if (!equal(await this.read(0xb2, 1, signal), Uint8Array.of(divisor))) continue;
          const ids = [];
          for (let i = 0; i < 3; i++) ids.push(await this.read(0x7d, 3, signal));
          if (!equal(ids[0], ids[1]) || !equal(ids[0], ids[2])) continue;
          if (ids[0][1] !== 0x62 || ids[0][2] !== 0x55) {
            throw new Error(`Unsupported chip ${hex(ids[0])}; this reader supports TLSR825x ID 0x5562`);
          }
          this.log(`Chip ${hex(ids[0])}, SWS divider ${divisor}`);
          // Release flash deep power-down (0xAB); does not program flash.
          await this.reg(0x0d, [0]); await this.reg(0x0c, [0xab, 1]); await this.reg(0x0d, [1]);
          await sleep(1);
          return {chipId: hex(ids[0]), divisor};
        } catch (error) {
          if (signal?.aborted || this.io.error || error.message.startsWith('Unsupported chip')) throw error;
        }
      }
      throw new Error('SWS calibration failed. Check wiring, power and activation time; try resetting the tag');
    }
    async spiRead(command, count, signal, readData = this.read.bind(this)) {
      await this.reg(0xb3, [0x80]);
      try {
        await this.reg(0x0d, [0]); await this.reg(0x0c, [...command, 0]);
        await this.reg(0x0d, [0x0a]);
        return await readData(0x0c, count, signal);
      } finally { await this.reg(0x0d, [1]); await this.reg(0xb3, [0]); }
    }
    readFlash(address, count, signal) {
      if (!Number.isInteger(address) || address < 0 || address + count > 0x1000000 || count < 1 || count > 256) throw new Error('Invalid flash read range');
      return this.spiRead([3, (address >> 16) & 255, (address >> 8) & 255, address & 255], count, signal);
    }
    async restore() {
      const warnings = [];
      const attempt = async operation => { try { await operation(); } catch (e) { warnings.push(e.message); } };
      await attempt(() => this.io.settle());
      await attempt(() => this.io.send(stop()));
      await attempt(() => this.reg(0x0d, [1]));
      await attempt(() => this.reg(0xb3, [0]));
      await attempt(() => this.reg(0x6f, [0x22]));
      await attempt(() => this.io.port.setSignals({dataTerminalReady: false, requestToSend: false}));
      return warnings;
    }
  }

  class USBBridge {
    constructor(device) { this.device = device; }
    setup(request, value = 0) { return {requestType: 'vendor', recipient: 'device', request, value, index: 0}; }
    async input(request, length, value = 0) {
      const reply = await bounded(this.device.controlTransferIn(this.setup(request, value), length), 2000, 'RP2040 USB request timed out');
      if (reply.status !== 'ok' || reply.data?.byteLength !== length) throw new Error(`Incomplete RP2040 USB reply (request 0x${request.toString(16)})`);
      return reply.data;
    }
    async output(request, value = 0) {
      const reply = await bounded(this.device.controlTransferOut(this.setup(request, value)), 2000, 'RP2040 USB request timed out');
      if (reply.status !== 'ok') throw new Error(`RP2040 USB request 0x${request.toString(16)} failed`);
    }
    async status() {
      const data = await this.input(1, 40);
      if (data.getUint32(0, true) !== 0x31505348) throw new Error('Unexpected RP2040 firmware');
      const version = data.getUint32(4, true);
      if (![0x10003, 0x10004, 0x10005].includes(version)) throw new Error('Install a supported RP2040 bridge v1.3, v1.4 or v1.5 UF2 for browser readback');
      return {version: `${version >>> 16}.${version & 0xffff}`, flags: data.getUint32(8, true), tx: data.getUint32(24, true), faults: data.getUint32(28, true)};
    }
    async open() {
      if (this.device.vendorId !== 0xcafe || this.device.productId !== 0x4012) throw new Error('Select the Hanshow RP2040 bridge');
      await this.device.open();
      if (!this.device.configuration) await this.device.selectConfiguration(1);
      await this.device.claimInterface(4);
      const status = await this.status();
      // Select three-byte headers before opening CDC, including after a Python
      // session selected the 826x backend. Busy CDC/capture is rejected by firmware.
      if (status.version === '1.5') {
        await this.output(0x21, 3);
        if ((await this.input(0x21, 4)).getUint32(0, true) !== 3) throw new Error('SWS address width did not verify');
      }
      return status;
    }
    async block(count, signal) {
      let completed = false;
      try {
        check(signal); await this.output(0x10, count);
        const deadline = performance.now() + 10000;
        while (performance.now() < deadline) {
          check(signal);
          const data = await this.input(0x11, 8);
          const state = data.getUint32(0, true), received = data.getUint32(4, true);
          if (state === 2) {
            if (received !== count) throw new Error(`RP2040 returned ${received}/${count} bytes`);
            const payload = await this.input(0x13, count);
            completed = true;
            return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength).slice();
          }
          if (state !== 1) throw new Error(`RP2040 block read failed after ${received} bytes (state ${state})`);
          await sleep(5);
        }
        throw new Error('RP2040 block read timed out');
      } finally {
        if (!completed) { await this.output(0x12); await sleep(60); }
      }
    }
    async close() {
      if (this.device.opened) await bounded(this.device.close(), 3000, 'RP2040 USB device did not close');
    }
  }

  class RP2040Reader extends Reader {
    constructor(io, bridge, log) { super(io, log); this.bridge = bridge; this.blockSize = 4096; }
    async activate(options) {
      // Verify that the separately selected serial port belongs to this bridge's
      // SWS interface before stopping a CPU. Wrong UART/board selections fail.
      await this.io.settle();
      const before = await this.bridge.status();
      await this.io.send(stop()); await sleep(25);
      const after = await this.bridge.status();
      if (((after.tx - before.tx) >>> 0) !== 10) throw new Error('Serial and USB selections do not match. Select this RP2040’s SWS port (if00), close other tools and retry');
      this.paired = true;
      const identity = await super.activate(options);
      // Same 24 MHz SWS rate used in the verified Zero block benchmarks.
      await this.reg(0xb2, [52]);
      if (!equal(await this.read(0xb2, 1, options.signal), Uint8Array.of(52))) throw new Error('RP2040 SWS divider verification failed');
      identity.divisor = 52;
      this.baseline = await this.bridge.status();
      this.transportDetails = {programmer: 'Hanshow RP2040-Zero', bridgeVersion: this.baseline.version,
        bridgeSerial: this.bridge.device.serialNumber, mode: 'native 4096-byte USB blocks',
        initialTransportFaults: this.baseline.faults};
      return identity;
    }
    async blockRead(address, count, signal) {
      await this.io.send(encode(header(address, 0x80)));
      try { return await this.bridge.block(count, signal); }
      finally { await this.io.settle(); await this.io.send(stop()); }
    }
    readFlash(address, count, signal) {
      if (!Number.isInteger(address) || address < 0 || address + count > 0x1000000 || count < 1 || count > 4096) throw new Error('Invalid RP2040 flash read range');
      return this.spiRead([3, (address >> 16) & 255, (address >> 8) & 255, address & 255], count, signal, this.blockRead.bind(this));
    }
    async verifyTransport() {
      const final = await this.bridge.status();
      this.transportDetails.finalTransportFaults = final.faults;
      if (final.faults !== this.baseline.faults) throw new Error('RP2040 reported transport faults during readback; no complete backup will be offered');
    }
    async restore() {
      // A failed USB/serial association must not reset an unrelated tag.
      if (!this.paired) return [];
      return super.restore();
    }
  }

  async function capture(reader, options = {}) {
    const {signal, fullVerify = false, progress = () => {}} = options;
    let result, failure;
    const started = new Date().toISOString();
    try {
      const identity = await reader.activate(options);
      const jedec = await reader.spiRead([0x9f], 3, signal);
      const size = flashSize(jedec);
      reader.log(`Flash ${hex(jedec)}: ${size.toLocaleString()} bytes. Reading every address from zero…`);
      const data = new Uint8Array(size);
      const blockSize = reader.blockSize || 256;
      for (let address = 0; address < size; address += blockSize) {
        check(signal);
        const count = Math.min(blockSize, size - address);
        data.set(await reader.readFlash(address, count, signal), address);
        progress({phase: 'Reading', done: address + count, total: size});
      }
      const samples = [];
      if (!fullVerify) {
        for (let address = 0; address < size; address += 65536) samples.push(address);
        if (!samples.includes(size - 256)) samples.push(size - 256);
      }
      const verificationTotal = fullVerify ? size : samples.length * 256;
      const verifyBlockSize = fullVerify ? blockSize : 256;
      for (let done = 0; done < verificationTotal; done += verifyBlockSize) {
        check(signal);
        const address = fullVerify ? done : samples[done / 256];
        const count = Math.min(verifyBlockSize, verificationTotal - done);
        const fresh = await reader.readFlash(address, count, signal);
        if (!equal(fresh, data.subarray(address, address + count))) throw new Error(`Verification mismatch at 0x${address.toString(16).padStart(6, '0')}; no complete backup will be offered`);
        progress({phase: 'Verifying', done: done + count, total: verificationTotal});
      }
      check(signal);
      if (reader.verifyTransport) await reader.verifyTransport();
      result = {data, metadata: {
        format: 'TLSR825x raw full flash', startAddress: 0, bytes: size,
        ...identity, jedecId: hex(jedec), baudRate: 921600, started,
        captured: new Date().toISOString(), verification: fullVerify ? 'two complete matching reads' : 'sample readback matched',
        sampleAddresses: fullVerify ? [] : samples,
        transport: reader.transportDetails,
        allZero: data.every(b => b === 0), allFF: data.every(b => b === 255),
      }};
    } catch (error) { failure = error; }
    // Cleanup is deliberately independent of the cancellation signal.
    const warnings = await reader.restore();
    if (failure) { failure.cleanupWarnings = warnings; throw failure; }
    result.metadata.resetEchoVerified = warnings.length === 0;
    result.metadata.cleanupWarnings = warnings;
    return result;
  }
  const api = {encode, writePacket, decode, SerialIO, Reader, USBBridge, RP2040Reader, capture, flashSize, hex, equal};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FirmwareDump = api;
})(globalThis);
