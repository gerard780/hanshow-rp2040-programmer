/* Guarded application installation over the existing v1.6 SWS transport.
 * No mass erase or writes at/above 0x20000. Plans are built from fresh same-tag reads or supplied explicitly.
 */
(function (root) {
  'use strict';
  const dump = typeof module !== 'undefined' && module.exports ? require('./sws.js') : root.FirmwareDump;
  const {equal, hex} = dump;
  const SECTOR = 4096, PAGE = 256, LIMIT = 0x20000, SIZE = 524288;
  const D9_HEADER = Object.freeze([0x44,0x39,0x4a,0x52,1,32,127,0,0,0xf0,1,0,0,0x10,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0xa1,0xb5,0x3d,0xaf]);
  const JOURNAL_ADDRESS = 0x1f000;
  const matchesJournalHeader = (bytes, offset) => D9_HEADER.every((value, i) => bytes[offset + i] === value);
  const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
  const digest = async data => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
  const cancelled = signal => { if (signal?.aborted) throw new DOMException('Installation cancelled', 'AbortError'); };
  function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function inspectBackups(first, second) {
    requireValue(first.length === SIZE && second.length === SIZE, 'Incomplete full backups; writes refused');
    const reads = await Promise.all([first, second].map(async bytes => ({
      sha256: await digest(bytes), allZero: bytes.every(byte => byte === 0), allFF: bytes.every(byte => byte === 255),
    })));
    let mismatchedBytes = 0;
    const sectors = new Set(), firstDifferences = [];
    for (let offset = 0; offset < SIZE; offset++) {
      if (first[offset] === second[offset]) continue;
      mismatchedBytes++; sectors.add(Math.floor(offset / SECTOR) * SECTOR);
      if (firstDifferences.length < 8) firstDifferences.push({offset, read1: first[offset], read2: second[offset]});
    }
    return {reads, mismatchedBytes, differingSectors: [...sectors], firstDifferences,
      valid: mismatchedBytes === 0 && reads.every(read => !read.allZero && !read.allFF)};
  }
  async function validateBinary(input, {allowJournalRecords = false} = {}) {
    const bytes = Uint8Array.from(input);
    requireValue(bytes.length >= 32 && bytes.length <= LIMIT, 'Select an application .bin of 32 to 131072 bytes; full tag dumps and UF2 files are not supported');
    const view = new DataView(bytes.buffer), length = view.getUint32(24, true);
    const paddedLength = Math.ceil(length / SECTOR) * SECTOR;
    requireValue(hex(bytes.subarray(8, 12)) === '4b4e4c54' && length >= 32 && length <= bytes.length && paddedLength <= LIMIT,
      'Invalid application header or length');
    requireValue(view.getUint32(length - 4, true) === ((crc32(bytes.subarray(0, length - 4)) ^ 0xffffffff) >>> 0), 'Application checksum invalid');
    // D9 embeds its exact, CRC-covered journal descriptor in the firmware.
    // Recognize that descriptor only when code ends before its reserved sector.
    let descriptors = 0;
    if (length <= JOURNAL_ADDRESS) for (let i = 0; i <= length - D9_HEADER.length; i++) {
      if (bytes[i] === 0x44 && matchesJournalHeader(bytes, i)) descriptors++;
    }
    const journal = descriptors === 1;
    const outputLength = journal ? LIMIT : paddedLength;
    requireValue(bytes.length === length || bytes.length === paddedLength || (journal && bytes.length === LIMIT),
      'Unexpected bytes after application; use a raw or FF-padded application .bin');
    requireValue(bytes.subarray(length, journal ? JOURNAL_ADDRESS : bytes.length).every(byte => byte === 255),
      'Unexpected application padding');
    const application = new Uint8Array(outputLength); application.fill(255); application.set(bytes.subarray(0, length));
    if (journal) {
      if (bytes.length === LIMIT && !bytes.subarray(JOURNAL_ADDRESS).every(byte => byte === 255)) {
        requireValue(matchesJournalHeader(bytes, JOURNAL_ADDRESS), 'Invalid D9 journal header');
        requireValue(allowJournalRecords || bytes.subarray(JOURNAL_ADDRESS + D9_HEADER.length).every(byte => byte === 255),
          'Do not distribute a captured per-tag journal; choose the application binary');
        application.set(bytes.subarray(JOURNAL_ADDRESS), JOURNAL_ADDRESS);
      } else application.set(D9_HEADER, JOURNAL_ADDRESS);
    }
    return {kind: 'single-bin', application, firmwareBytes: length, firmwareSha256: await digest(bytes.subarray(0, length)), discoveryJournal: journal};
  }

  async function prepareFromBinary(input, before) {
    const binary = await validateBinary(input); before = Uint8Array.from(before);
    requireValue(before.length === SIZE && !before.every(byte => byte === 0) && !before.every(byte => byte === 255), 'Expected a complete nonblank same-tag snapshot');
    const application = binary.application, expected = before.slice();
    let journalAction = null;
    if (binary.discoveryJournal) {
      journalAction = matchesJournalHeader(before, JOURNAL_ADDRESS) ? 'preserved' : 'initialized';
      if (journalAction === 'preserved') application.set(before.subarray(JOURNAL_ADDRESS, LIMIT), JOURNAL_ADDRESS);
    }
    expected.set(application);
    const order = [];
    for (let offset = SECTOR; offset < application.length; offset += SECTOR) {
      if (!equal(before.subarray(offset, offset + SECTOR), expected.subarray(offset, offset + SECTOR))) order.push(offset);
    }
    if (!equal(before.subarray(0, SECTOR), expected.subarray(0, SECTOR))) order.push(0);
    const meta = {hardware_access: false, write_start: 0, write_bytes: application.length, sector_size: SECTOR,
      preserve_start: application.length, preserve_end: SIZE, backup_sha256: await digest(before),
      firmware_sha256: binary.firmwareSha256, expected_full_flash_sha256: await digest(expected), sectors_in_write_order: order,
      discovery_journal: journalAction ? {address: JOURNAL_ADDRESS, bytes: SECTOR, action: journalAction} : null};
    return validatePlan(meta, application, expected, before.subarray(0, application.length));
  }
  async function validatePlan(meta, application, expected, recovery) {
    // Own copies: callers cannot alter the checked image during an await.
    meta = JSON.parse(JSON.stringify(meta));
    application = Uint8Array.from(application); expected = Uint8Array.from(expected); recovery = Uint8Array.from(recovery);
    requireValue(meta.hardware_access === false && meta.write_start === 0 && meta.sector_size === SECTOR &&
      meta.write_bytes === application.length && meta.preserve_start === application.length && meta.preserve_end === SIZE,
      'Unsupported application plan geometry');
    requireValue(application.length >= SECTOR && application.length <= LIMIT && application.length % SECTOR === 0,
      'Application must contain full sectors below 0x20000');
    requireValue(expected.length === SIZE && recovery.length === application.length, 'Incomplete expected/recovery image');
    requireValue(await digest(expected) === meta.expected_full_flash_sha256 && equal(application, expected.subarray(0, application.length)),
      'Expected image differs from application plan');
    const binary = await validateBinary(application, {allowJournalRecords: true});
    requireValue(binary.firmwareSha256 === meta.firmware_sha256 && equal(binary.application, application), 'Application hash or padding invalid');
    return {meta, application, expected, recovery};
  }
  async function checkBackup(plan, before) {
    requireValue(before.length === SIZE && await digest(before) === plan.meta.backup_sha256,
      'Fresh same-tag backup differs from prepared plan; writes refused');
    requireValue(equal(plan.recovery, before.subarray(0, plan.application.length)) &&
      equal(plan.expected.subarray(plan.application.length), before.subarray(plan.application.length)),
      'Plan changes preserved flash or recovery differs from same-tag backup');
    const order = [];
    for (let offset = SECTOR; offset < plan.application.length; offset += SECTOR) {
      if (!equal(before.subarray(offset, offset + SECTOR), plan.expected.subarray(offset, offset + SECTOR))) order.push(offset);
    }
    if (!equal(before.subarray(0, SECTOR), plan.expected.subarray(0, SECTOR))) order.push(0);
    requireValue(JSON.stringify(order) === JSON.stringify(plan.meta.sectors_in_write_order),
      'Plan sector order differs; sector zero must be last');
    return order;
  }
  class FlashSession {
    constructor(reader) { this.reader = reader; this.protection = null; this.unlocked = false; this.allowWrites = false; }
    async spi(command, count = 0, {legacyStatus = false} = {}) {
      const opcode = command[0];
      requireValue([3, 5, 0x35, 0x9f, 0x4b, 1, 2, 6, 0x20].includes(opcode), 'SPI opcode outside application policy');
      if ([1, 2, 6, 0x20].includes(opcode)) requireValue(this.allowWrites, 'Flash writes are disabled');
      if ([2, 0x20].includes(opcode)) {
        const address = command[1] * 65536 + command[2] * 256 + command[3];
        requireValue(this.unlocked && command.length >= 4 && Number.isInteger(address) && address >= 0 && address < LIMIT,
          'Unlocked application-only write required');
        if (opcode === 0x20) requireValue(command.length === 4 && address % SECTOR === 0 && address + SECTOR <= LIMIT, 'Erase outside application region');
        else requireValue(command.length >= 5 && command.length <= 260 && address + command.length - 4 <= LIMIT &&
          address % PAGE + command.length - 4 <= PAGE, 'Program crosses a page or application boundary');
      }
      if (opcode === 1) requireValue(this.protection !== null && command.length === 3 &&
        [this.protection, this.protection & ~0x407c].includes(command[1] | command[2] << 8), 'Status write must preserve saved non-protection bits');
      requireValue(Number.isInteger(count) && count >= 0 && count <= SECTOR, 'Invalid SPI read size');
      try {
        await this.reader.reg(0xb3, [0x80]); await this.reader.reg(0x0d, [0]);
        await this.reader.reg(0x0c, [...command, ...(count ? [0] : [])]);
        if (!count) return new Uint8Array();
        await this.reader.reg(0x0d, [0x0a]);
        const bytes = legacyStatus ? await this.reader.read(0x0c, count) : await this.reader.blockRead(0x0c, count);
        requireValue(bytes.length === count, 'Incomplete SPI response');
        return bytes;
      } finally {
        try { await this.reader.reg(0x0d, [1]); } finally { await this.reader.reg(0xb3, [0]); }
      }
    }
    async status() { return (await this.spi([5], 1))[0] | (await this.spi([0x35], 1))[0] << 8; }
    async ready(legacyStatus = false) {
      const deadline = performance.now() + 10000;
      do {
        if (!((await this.spi([5], 1, {legacyStatus}))[0] & 1)) return;
        await new Promise(resolve => setTimeout(resolve, 1));
      } while (performance.now() < deadline);
      throw new Error('Flash remained busy');
    }
    async setStatus(value) {
      await this.spi([6]); await this.spi([1, value & 255, value >> 8]); await this.ready();
      requireValue(await this.status() === value, 'Protection status did not verify');
    }
    async unlock() {
      requireValue(this.protection === null, 'Protection already saved');
      const value = await this.status();
      requireValue([0x2c, 0x382c].includes(value), 'Unknown protection layout');
      this.protection = value; // save before first potentially partial mutation
      await this.setStatus(value & ~0x407c); this.unlocked = true;
    }
    async restoreProtection() {
      if (this.protection !== null) { this.unlocked = false; await this.setStatus(this.protection); }
    }
    readSector(offset) {
      requireValue(Number.isInteger(offset) && offset >= 0 && offset % SECTOR === 0 && offset + SECTOR <= SIZE, 'Read outside main flash');
      return this.spi([3, offset >> 16, offset >> 8 & 255, offset & 255], SECTOR);
    }
    async writeSector(offset, data, before, recovery = false) {
      requireValue(offset % SECTOR === 0 && offset >= 0 && offset + SECTOR <= LIMIT && data.length === SECTOR && before.length === SECTOR,
        'Write outside application sector boundaries');
      requireValue(equal(await this.readSector(offset), before), 'Live sector differs from saved pre-write contents');
      await this.spi([6]); await this.spi([0x20, offset >> 16, offset >> 8 & 255, offset & 255]); await this.ready(recovery);
      requireValue((await this.readSector(offset)).every(byte => byte === 255), 'Sector did not become erased; programming refused');
      const chunk = recovery ? 64 : PAGE;
      for (let index = 0; index < SECTOR; index += chunk) {
        const page = data.subarray(index, index + chunk), address = offset + index;
        if (page.every(byte => byte === 255)) continue;
        await this.spi([6]); await this.spi([2, address >> 16, address >> 8 & 255, address & 255, ...page]); await this.ready(recovery);
      }
      const actual = await this.readSector(offset);
      if (!equal(actual, data)) {
        const first = data.findIndex((byte, i) => byte !== actual[i]);
        const error = new Error(`Programmed sector readback mismatch at sector 0x${offset.toString(16)}, address 0x${(offset + first).toString(16)}`);
        error.sectorDiagnostic = {offset, firstMismatchAddress: offset + first, expectedSha256: await digest(data), readbackSha256: await digest(actual)};
        throw error;
      }
    }
    async fullRead(phase, signal, progress) {
      const data = new Uint8Array(SIZE);
      for (let offset = 0; offset < SIZE; offset += SECTOR) {
        cancelled(signal); const bytes = await this.readSector(offset);
        requireValue(bytes.length === SECTOR, 'Incomplete full-flash read'); data.set(bytes, offset);
        progress({phase, done: offset + SECTOR, total: SIZE});
      }
      return data;
    }
  }
  async function installApplication(reader, plan, options = {}) {
    const {signal, progress = () => {}, saveBackup, saveRecoveryBackup = true, apply = false, onEvent = () => {}} = options;
    // Revalidate an owned copy before any hardware operation. A single binary
    // becomes a per-tag plan only after two complete matching live reads.
    const binary = plan instanceof Uint8Array ? await validateBinary(plan) :
      plan?.kind === 'single-bin' ? await validateBinary(plan.application) : null;
    plan = binary ? null : await validatePlan(plan.meta, plan.application, plan.expected, plan.recovery);
    const flash = new FlashSession(reader), touched = [];
    const report = {webFlasherRevision: dump.revision, apply, baudRate: reader.baudRate, inputMode: binary ? 'single-bin' : 'prepared-plan', backupRequested: saveRecoveryBackup, backupSaved: false, verified: false, attemptedSectors: touched, writtenSectors: [], cpuResetVerified: false, events: []};
    const event = (name, details = {}) => {
      report.events.push({event: name, ...details});
      // UI/logging failures must not interrupt preservation or recovery.
      try { onEvent(name, details); } catch (_) { /* journal remains in report */ }
    };
    let before = null, uid, failure, trustedBefore = !(options.expectedBackupSha256 || options.expectedFlashUidSha256);
    let imageVerified = trustedBefore, protectionVerified = true;
    try {
      const bridge = await reader.bridge.status();
      requireValue(bridge.version === '1.6', 'Browser flashing requires the tested RP2040 v1.6 UF2');
      requireValue(!apply || [460800, 921600, 1500000].includes(reader.baudRate), 'Browser writes require 1.5 Mbaud or 921600 baud, or 460800 baud for slower operation. Disconnect and select the lower rate before opening the SWS port; 2 Mbaud remains available for readback and checks');
      cancelled(signal);
      const identity = await reader.activate(options);
      requireValue(identity.chipId === '026255', 'Flashing supports chip 026255 only');
      requireValue(equal(await reader.read(0x602, 1, signal), Uint8Array.of(5)), 'CPU halt did not verify');
      requireValue(hex(await flash.spi([0x9f], 3)) === 'eb6013', 'Flashing supports EB6013 512 KiB flash only');
      uid = await flash.spi([0x4b, 0, 0, 0, 0], 16);
      requireValue(!uid.every(byte => byte === 0) && !uid.every(byte => byte === 255) &&
        equal(uid, await flash.spi([0x4b, 0, 0, 0, 0], 16)), 'Flash UID did not repeat');
      const protection = await flash.status();
      requireValue([0x2c, 0x382c].includes(protection), 'Unknown protection layout');
      if (options.expectedProtection !== undefined) requireValue(protection === options.expectedProtection,
        'Protection changed after original-image recovery; application writes refused');
      Object.assign(report, identity, {jedecId: 'eb6013', flashUid: hex(uid), protectionOriginal: protection, bridgeVersion: bridge.version});
      before = await flash.fullRead('Reading tag (pass 1)', signal, progress);
      const second = await flash.fullRead('Reading tag (pass 2)', signal, progress);
      const validation = await inspectBackups(before, second);
      report.backupValidation = validation;
      event('backup_read_hashes', {message: validation.reads.map((read, i) => `Read ${i + 1} SHA-256: ${read.sha256}${read.allZero ? ' (entirely 00)' : read.allFF ? ' (entirely FF)' : ''}`).join('; ')});
      if (!validation.valid) {
        const where = offset => `0x${offset.toString(16).padStart(6, '0')}`;
        const byte = value => value.toString(16).padStart(2, '0');
        let message;
        if (validation.mismatchedBytes) {
          const first = validation.firstDifferences[0];
          message = `Fresh full backups differ: ${validation.mismatchedBytes} byte${validation.mismatchedBytes === 1 ? '' : 's'} across ${validation.differingSectors.length} sector${validation.differingSectors.length === 1 ? '' : 's'}; first mismatch at ${where(first.offset)} (read 1 ${byte(first.read1)}, read 2 ${byte(first.read2)}); writes refused`;
          event('backup_read_differences', {message: 'First differences (read 1/read 2): ' + validation.firstDifferences.map(d => `${where(d.offset)} ${byte(d.read1)}/${byte(d.read2)}`).join(', ')});
        } else {
          message = `Both full backup reads are entirely ${validation.reads[0].allZero ? '00' : 'FF'}; no usable backup; writes refused`;
        }
        throw new Error(message);
      }
      if (options.expectedBackupSha256) requireValue(await digest(before) === options.expectedBackupSha256,
        'Tag contents changed after original-image recovery; application writes refused');
      if (options.expectedFlashUidSha256) requireValue(await digest(uid) === options.expectedFlashUidSha256,
        'Target changed after original-image recovery; application writes refused');
      trustedBefore = true; imageVerified = true;
      if (binary) plan = await prepareFromBinary(binary.application, before);
      const order = await checkBackup(plan, before);
      report.firmwareSha256 = plan.meta.firmware_sha256;
      report.applicationBytes = plan.application.length;
      report.discoveryJournal = plan.meta.discovery_journal;
      await reader.verifyTransport();
      report.backupSha256 = await digest(before); report.plannedSectors = order;
      event('plan_verified', {sectors: order.length});
      cancelled(signal);
      if (saveRecoveryBackup) {
        requireValue(typeof saveBackup === 'function', 'Choose a recovery backup file before flashing');
        // Callback must commit and reread the file, returning its persisted hash.
        const persisted = await saveBackup(before.slice(), {...report});
        requireValue(persisted === report.backupSha256, 'Saved recovery backup did not verify; writes refused');
        report.backupSaved = true; event('recovery_backup_saved');
      } else {
        report.recoveryStorage = 'browser memory only'; event('recovery_backup_not_saved');
      }
      cancelled(signal);
      if (apply && order.length) {
        requireValue(equal(uid, await flash.spi([0x4b, 0, 0, 0, 0], 16)), 'Target changed before unlock');
        imageVerified = false; protectionVerified = false; flash.allowWrites = true;
        await flash.unlock();
        for (let index = 0; index < order.length; index++) {
          cancelled(signal); const offset = order[index];
          requireValue(equal(await reader.read(0x602, 1), Uint8Array.of(5)), 'CPU no longer halted');
          touched.push(offset); // recovery includes a partial erase/program
          event('sector_attempted', {offset});
          await flash.writeSector(offset, plan.expected.subarray(offset, offset + SECTOR), before.subarray(offset, offset + SECTOR), !!options.conservative);
          report.writtenSectors.push(offset); event('sector_verified', {offset});
          progress({phase: 'Programming', done: (index + 1) * SECTOR, total: order.length * SECTOR});
        }
        const after = await flash.fullRead('Verifying complete flash', signal, progress);
        requireValue(equal(after, plan.expected), 'Complete programmed flash differs from expected image');
        await reader.verifyTransport(); imageVerified = true; report.expectedSha256 = await digest(after);
        event('complete_image_verified');
      } else if (apply) report.alreadyInstalled = true;
    } catch (error) {
      failure = error; event('installation_failed', {message: error.message});
      if (error.transportDiagnostic) report.transportDiagnostic = error.transportDiagnostic;
      if (error.sectorDiagnostic) report.sectorDiagnostic = error.sectorDiagnostic;
      if (touched.length && before) {
        imageVerified = false;
        try {
          await reader.resynchronize();
          event('recovery_transport_resynchronized', {baudRate: reader.baudRate});
          requireValue(equal(uid, await flash.spi([0x4b, 0, 0, 0, 0], 16)), 'Recovery target changed');
          const order = [...new Set(touched.filter(offset => offset !== 0))].sort((a, b) => a - b);
          if (touched.includes(0)) order.push(0);
          for (const offset of order) {
            event('recovery_sector_attempted', {offset});
            await flash.writeSector(offset, before.subarray(offset, offset + SECTOR), await flash.readSector(offset), true);
            event('recovery_sector_verified', {offset});
            progress({phase: 'Restoring original application', done: (order.indexOf(offset) + 1) * SECTOR, total: order.length * SECTOR});
          }
          requireValue(equal(await flash.fullRead('Verifying recovery', undefined, progress), before), 'Complete recovery verification failed');
          imageVerified = true; report.recoveryVerified = true; event('original_image_restored');
        } catch (error) { report.recoveryError = error.message; event('recovery_failed', {message: error.message}); }
      } else imageVerified = trustedBefore; // no erase/program; chained recovery still requires its expected snapshot
    } finally {
      if (flash.protection !== null) {
        try {
          if (failure) await reader.resynchronize();
          await flash.restoreProtection(); requireValue(await flash.status() === flash.protection, 'Protection restore did not repeat');
          protectionVerified = true; report.protectionFinal = flash.protection; event('protection_restored');
        } catch (error) { protectionVerified = false; report.protectionError = error.message; event('protection_restore_failed', {message: error.message}); }
      }
      if (imageVerified && protectionVerified) {
        const warnings = await reader.restore(); report.cleanupWarnings = warnings;
        report.cpuResetVerified = !!reader.paired && warnings.length === 0;
        if (warnings.length && !failure) failure = new Error('Tag reset/cleanup did not verify');
      } else {
        report.cpuKeptHalted = true;
        // Do not call Reader.restore(), which unconditionally resets CPU.
        const warnings = [];
        for (const operation of [() => reader.bridge.output(0x12), () => reader.io.send(dump.encode([0xff])),
          () => reader.reg(0x0d, [1]), () => reader.reg(0xb3, [0]),
          () => reader.io.port.setSignals({dataTerminalReady: false, requestToSend: false})]) {
          try { await operation(); } catch (e) { warnings.push(e.message); }
        }
        report.cleanupWarnings = warnings; event('cpu_kept_halted');
      }
    }
    report.verified = !failure && imageVerified && protectionVerified && report.cpuResetVerified;
    if (failure || !report.verified) {
      failure ||= new Error('Installation cleanup or recovery did not verify');
      failure.report = report;
      // If the user skipped saving and recovery failed, keep the original
      // snapshot available for an explicit emergency download in this session.
      if (before && report.cpuKeptHalted && !report.backupSaved) failure.recoveryBackup = before.slice();
      throw failure;
    }
    return report;
  }
  const api = {D9_HEADER, inspectBackups, validateBinary, prepareFromBinary, validatePlan, checkBackup, FlashSession, installApplication, digest, crc32};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FirmwareFlash = api;
})(globalThis);
