/* Serial-only adapter: UART echoes and nine sampled bytes per read trigger.
 * It deliberately provides no usable RP2040 USB API.
 */
(function (root) {
  const Base = typeof module !== 'undefined' && module.exports
    ? require('./fake-rp2040.js').FakeRP2040 : root.FakeRP2040;
  class FakeCH340 extends Base {
    constructor() {
      super();
      this.vendorId = 0x1a86; this.productId = 0x7523;
      this.jedec = [0xc8, 0x60, 0x10]; // Recognized 64 KiB flash keeps tests bounded.
      this.memory = this.memory.slice(0, 65536);
      this.flashReads = 0; this.corruptAtRead = -1; this.corruptAtOffset = 0;
      this.invalidSample = false; this.fragmentReplies = false; this.triggers = 0;
    }
    getInfo() { return {usbVendorId: this.vendorId, usbProductId: this.productId}; }
    async controlTransferIn() { throw new Error('CH340 must not use WebUSB'); }
    async controlTransferOut() { throw new Error('CH340 must not use WebUSB'); }
    flushFrame() {
      if (this.frame[0] === 0x5a && this.frame[4] === 0 &&
          this.frame[3] === 0x0c && this.frame[5] === 3) this.flashReads++;
      super.flushFrame();
    }
    readByte() {
      const isFlash = this.readAddress === 0x0c && this.spiCommand === 3;
      const offset = this.spiAddress;
      const value = super.readByte();
      return isFlash && this.flashReads === this.corruptAtRead && offset === this.corruptAtOffset ? value ^ 1 : value;
    }
    echo(bytes) {
      if (this.fragmentReplies && bytes.length === 9) {
        for (const part of [bytes.slice(0, 1), bytes.slice(1, 3), bytes.slice(3)]) super.echo(part);
      } else super.echo(bytes);
    }
    write(bytes) {
      if (bytes.length === 1 && bytes[0] === 0xfe) {
        this.triggers++;
        if (this.invalidSample) {
          this.echo(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0)); return;
        }
      }
      super.write(bytes);
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {FakeCH340};
  else root.FakeCH340 = FakeCH340;
})(globalThis);
