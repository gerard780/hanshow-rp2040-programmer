/* Match the same factory product and complete waveform package as D10's planner. */
(function (root) {
  'use strict';
  const F = typeof module !== 'undefined' && module.exports ? require('../flash.js') : root.FirmwareFlash;
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  async function validateTarget(input, manifest) {
    const bytes = Uint8Array.from(input);
    if (bytes.length !== 0x80000 || hex(bytes.subarray(0x7e000, 0x7e05c)) !== manifest.accepted_product_record) {
      throw new Error('This tag does not match a supported Nebular 437 revision. No firmware was written.');
    }
    const digest = await F.digest(bytes.subarray(0x78000, 0x7b000));
    const matches = manifest.supported_banks.filter(bank => bank.sha256 === digest);
    if (matches.length !== 1) throw new Error('The tag’s factory waveforms are unrecognized or damaged. No firmware was written.');
    return matches[0].id;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {validateTarget};
  else root.D10Target = Object.freeze({validateTarget});
})(globalThis);
