const {digest, crc32} = require('../flash.js');
async function fixture(before) {
  const application = before.slice(0, 8192);
  application.set([0x4b, 0x4e, 0x4c, 0x54], 8);
  const view = new DataView(application.buffer);
  view.setUint32(24, application.length, true);
  application[500] ^= 1; application[5000] ^= 1;
  view.setUint32(application.length - 4, (crc32(application.subarray(0, -4)) ^ 0xffffffff) >>> 0, true);
  const expected = before.slice(); expected.set(application);
  return {meta: {hardware_access: false, write_start: 0, write_bytes: application.length, sector_size: 4096,
    preserve_start: application.length, preserve_end: before.length, backup_sha256: await digest(before),
    firmware_sha256: await digest(application), expected_full_flash_sha256: await digest(expected), sectors_in_write_order: [4096, 0]},
    application, expected, recovery: before.slice(0, application.length)};
}
module.exports = {fixture};
