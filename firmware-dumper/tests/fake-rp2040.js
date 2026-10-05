/* Emulates the existing bridge's CDC waveform echo and vendor control API.
 * Tests use known bytes; they never open a physical USB device.
 */
(function (root) {
  class FakeRP2040 {
    constructor() {
      this.memory = Uint8Array.from({length: 524288}, (_, i) => ((i >>> 8) ^ i ^ (i >>> 16)) & 255);
      this.jedec = [0xeb, 0x60, 0x13]; this.registers = new Map([[0xb2, 52]]);
      this.frame = []; this.readAddress = null; this.spiAddress = 0; this.spiCommand = 0;
      this.commands = []; this.tx = 0; this.faults = 0; this.resets = 0; this.signals = [];
      this.blockRequests = 0; this.blockState = 0; this.blockCount = 0; this.cancelCount = 0;
      this.baudRate = 921600; this.corruptOffset = 0; this.corruptAtBlock = -1; this.failAtBlock = -1; this.failUSBRequest = -1;
      this.shortPayload = false; this.stayBusy = false; this.serialClosed = false;
      this.vendorId = 0xcafe; this.productId = 0x4012; this.serialNumber = 'FAKE-ZERO'; this.opened = false;
      this.configuration = {configurationValue: 1}; this.version = 0x10005; this.addressWidth = 2;
      this.makeStreams();
    }
    makeStreams() {
      this.readable = new ReadableStream({start: controller => { this.rx = controller; }});
      this.writable = new WritableStream({write: bytes => this.write(bytes)});
    }
    echo(bytes) { this.rx.enqueue(bytes.slice()); }
    readByte() {
      const address = this.readAddress;
      if (address === 0x7d || address === 0x7e || address === 0x7f) {
        this.readAddress++; return [2, 0x62, 0x55][address - 0x7d];
      }
      if (address === 0x0c) {
        if (this.spiCommand === 0x9f) return this.jedec[this.spiAddress++];
        return this.memory[this.spiAddress++];
      }
      return this.registers.get(address) || 0;
    }
    flushFrame() {
      if (!this.frame.length || this.frame[0] !== 0x5a) { this.frame = []; return; }
      const address = (this.frame[1] << 16) | (this.frame[2] << 8) | this.frame[3];
      if (this.frame[4] === 0x80) { this.readAddress = address; this.frame = []; return; }
      const data = this.frame.slice(5);
      this.registers.set(address, data[0]);
      if (address === 0x6f) this.resets++;
      if (address === 0x0c) {
        this.spiCommand = data[0]; this.commands.push(data[0]);
        if (![3, 0x9f, 0xab].includes(data[0])) throw new Error(`Unexpected flash command ${data[0]}`);
        this.spiAddress = data[0] === 3 ? (data[1] << 16) | (data[2] << 8) | data[3] : 0;
      }
      this.frame = [];
    }
    write(bytes) {
      this.tx += bytes.length;
      if (bytes.length === 1 && bytes[0] === 0xfe && this.readAddress !== null) {
        const value = this.readByte();
        this.echo(Uint8Array.from({length: 9}, (_, i) => i === 8 ? 0xfe : (value & (0x80 >> i) ? 0x80 : 0xfe)));
        return;
      }
      if (bytes.length % 10) throw new Error('SWS word split across writes');
      this.echo(bytes);
      for (let offset = 0; offset < bytes.length; offset += 10) {
        let value = 0;
        for (let bit = 0; bit < 8; bit++) value = (value << 1) | (bytes[offset + bit + 1] === 0x80 ? 1 : 0);
        if (bytes[offset] === 0x80) {
          this.flushFrame();
          if (value === 0xff) { this.readAddress = null; continue; }
        }
        this.frame.push(value);
        if (this.frame.length === 5 && this.frame[4] === 0x80) this.flushFrame();
      }
    }
    async setSignals(value) { this.signals.push(value); }
    async close() { this.serialClosed = true; this.opened = false; }
    async open(options) { this.opened = true; if (options) this.baudRate = options.baudRate; }
    async selectConfiguration() {}
    async claimInterface(value) { if (value !== 4) throw new Error('Wrong USB interface'); this.claimed = value; }
    async controlTransferOut(setup) {
      this.validateSetup(setup);
      if (setup.request === 0x21) { this.addressWidth = setup.value; }
      else if (setup.request === 0x10) {
        if (this.readAddress !== 0x0c || setup.value < 1 || setup.value > 4096) throw new Error('Invalid native capture');
        this.blockCount = setup.value; this.blockRequests++;
        this.blockState = this.blockRequests === this.failAtBlock ? 3 : 2;
      } else if (setup.request === 0x12) { this.cancelCount++; this.blockState = 3; }
      else throw new Error('Unexpected control output');
      return {status: 'ok', bytesWritten: 0};
    }
    validateSetup(setup) {
      if (setup.requestType !== 'vendor' || setup.recipient !== 'device' || setup.index !== 0) throw new Error('Incorrect control setup');
      if (setup.request === this.failUSBRequest) throw new Error('USB unplugged');
    }
    async controlTransferIn(setup, length) {
      this.validateSetup(setup);
      const out = new DataView(new ArrayBuffer(length));
      if (setup.request === 0x21) { out.setUint32(0, this.addressWidth, true); }
      else if (setup.request === 1) {
        out.setUint32(0, 0x31505348, true); out.setUint32(4, this.version, true);
        out.setUint32(8, 1, true); out.setUint32(12, this.baudRate, true); out.setUint32(24, this.tx, true); out.setUint32(28, this.faults, true);
      } else if (setup.request === 0x11) {
        out.setUint32(0, this.stayBusy ? 1 : this.blockState, true); out.setUint32(4, this.blockCount, true);
      } else if (setup.request === 0x13) {
        const data = new Uint8Array(out.buffer);
        data.set(this.memory.subarray(this.spiAddress, this.spiAddress + length)); this.spiAddress += length;
        if (this.blockRequests === this.corruptAtBlock) data[this.corruptOffset] ^= 1;
        if (this.shortPayload) return {status: 'ok', data: new DataView(out.buffer, 0, length - 1)};
      } else throw new Error('Unexpected control input');
      return {status: 'ok', data: out};
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {FakeRP2040};
  else root.FakeRP2040 = FakeRP2040;
})(globalThis);
