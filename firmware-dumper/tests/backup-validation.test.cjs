const {test} = require('node:test');
const assert = require('node:assert/strict');
const {inspectBackups, digest} = require('../flash.js');
const snapshot = () => Uint8Array.from({length: 0x80000}, (_, i) => i & 255);
test('matching nonblank full reads are accepted and retain both hashes', async () => {
  const first = snapshot(), result = await inspectBackups(first, first.slice());
  assert(result.valid); assert.equal(result.mismatchedBytes, 0);
  assert.deepEqual(result.differingSectors, []); assert.deepEqual(result.firstDifferences, []);
  assert.equal(result.reads[0].sha256, await digest(first));
  assert.deepEqual(result.reads[0], result.reads[1]);
});
test('diagnostics count all differing bytes and sectors while bounding byte samples', async () => {
  const first = snapshot(), second = first.slice();
  for (const offset of [0x101, 0xfff, 0x1000, 0x7ffff]) second[offset] ^= 0x80;
  const result = await inspectBackups(first, second);
  assert(!result.valid); assert.equal(result.mismatchedBytes, 4);
  assert.deepEqual(result.differingSectors, [0, 0x1000, 0x7f000]);
  assert.deepEqual(result.firstDifferences[0], {offset: 0x101, read1: 1, read2: 129});
  assert.notEqual(result.reads[0].sha256, result.reads[1].sha256);
  second.fill(0xff);
  assert.equal((await inspectBackups(first, second)).firstDifferences.length, 8);
});
test('two matching blank reads are rejected separately from disagreement', async () => {
  for (const value of [0, 255]) {
    const first = new Uint8Array(0x80000).fill(value);
    const result = await inspectBackups(first, first.slice());
    assert(!result.valid); assert.equal(result.mismatchedBytes, 0);
    assert.equal(result.reads[0].allZero, value === 0);
    assert.equal(result.reads[0].allFF, value === 255);
  }
});
test('incomplete captures never become accepted backups', async () => {
  await assert.rejects(inspectBackups(snapshot(), new Uint8Array(1024)), /Incomplete/);
});
