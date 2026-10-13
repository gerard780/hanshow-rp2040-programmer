const {D9_HEADER,crc32}=require('../flash.js');
function status(version = 2) {
  const b = Uint8Array.from([0x43, 0xf0, version, 0, 32|2|8|128, 1, 2, 3, 6, 252, 2, 2, 77, 0, 0, 0, 3, 1, 5, 0]);
  return new DataView(b.buffer);
}
function journal() {
  const j = new Uint8Array(4096); j.fill(255); j.set(D9_HEADER);
  const p = j.subarray(32, 64); p.fill(0); p.set([0x44, 0x39, 0x4c, 0x47, 1, 2, 4, 1]);
  const d = new DataView(p.buffer, p.byteOffset, p.byteLength);
  d.setUint32(8, 3, true); d.setUint32(12, 2, true); d.setUint32(16, 77, true); d.setUint32(20, 12345, true);
  p[24] = 2; p[25] = 1; p[26] = 0x86; p[27] = 252; d.setUint32(28, crc32(p.subarray(0, 28)), true);
  return j;
}
module.exports={status,journal};
