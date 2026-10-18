const {test} = require('node:test');
const assert = require('node:assert/strict');
const F = require('../flash.js');
const {validateTarget} = require('../d10/target.js');
const asset = require('../d10/firmware.js');
const firmware = Uint8Array.from(Buffer.from(asset.base64, 'base64'));
const hex = bytes => Buffer.from(bytes).toString('hex');
function snapshot() {
  return Uint8Array.from({length: 0x80000}, (_, i) => (i ^ (i >>> 8) ^ (i >>> 16)) & 255);
}
async function metadata(before) {
  return {accepted_product_record: hex(before.subarray(0x7e000, 0x7e05c)),
    supported_banks: [{id: 'synthetic-bank', sha256: await F.digest(before.subarray(0x78000, 0x7b000))}]};
}
test('embedded firmware is the published D10 binary with its exact journal descriptor', async () => {
  assert.equal(firmware.length, 125012);
  const pinned = 'cea41f2aad7b9b0f6a4d3a89be401764a6abc5d50ebb167c628625f949ff1927';
  assert.equal(await F.digest(firmware), pinned);
  assert.equal(asset.manifest.sha256, pinned);
  const parsed = await F.validateBinary(firmware);
  assert(parsed.discoveryJournal);
  assert.equal(parsed.application.length, 0x20000);
  assert.deepEqual(parsed.application.subarray(0x1f000, 0x1f020), Uint8Array.from(F.D9_HEADER));
  assert.deepEqual(asset.manifest.supported_banks.map(b => b.id), ['0ASSPQ0NX', '0BNSPQ0UK', '0BNSPQ069']);
  assert.equal(asset.manifest.accepted_product_record.length, 92 * 2);
});
test('D10 plans initialize a journal and preserve all upper-flash bytes', async () => {
  const before = snapshot(), plan = await F.prepareFromBinary(firmware, before);
  assert.deepEqual(plan.expected.subarray(0x20000), before.subarray(0x20000));
  assert.equal(plan.meta.sectors_in_write_order.at(-1), 0);
  assert.equal(plan.meta.discovery_journal.action, 'initialized');
  before.set(F.D9_HEADER, 0x1f000);
  const upgrade = await F.prepareFromBinary(firmware, before);
  assert.equal(upgrade.meta.discovery_journal.action, 'preserved');
  assert.deepEqual(upgrade.expected.subarray(0x1f000, 0x20000), before.subarray(0x1f000, 0x20000));
});
test('target guard accepts an exact product and entire waveform package match', async () => {
  const before = snapshot();
  assert.equal(await validateTarget(before, await metadata(before)), 'synthetic-bank');
});
test('target guard rejects changed product, changed waveform and ambiguous manifests', async () => {
  const before = snapshot(), meta = await metadata(before);
  const wrongProduct = before.slice(); wrongProduct[0x7e010] ^= 1;
  await assert.rejects(validateTarget(wrongProduct, meta), /supported Nebular 437/);
  const wrongWaveform = before.slice(); wrongWaveform[0x79000] ^= 1;
  await assert.rejects(validateTarget(wrongWaveform, meta), /waveforms/);
  await assert.rejects(validateTarget(before.subarray(0, 0x40000), meta), /supported Nebular 437/);
  await assert.rejects(validateTarget(before, {...meta, supported_banks: [...meta.supported_banks, ...meta.supported_banks]}), /waveforms/);
});
