/* Original full-backup recovery. Never reset before verified image/protection. */
(function (root) {
  'use strict';
  const F = typeof module !== 'undefined' && module.exports ? require('./flash.js') : root.FirmwareFlash;
  const D = typeof module !== 'undefined' && module.exports ? require('./sws.js') : root.FirmwareDump;
  const SIZE = 524288, LIMIT = 131072, SECTOR = 4096;
  const need = (value, message) => { if (!value) throw new Error(message); };
  const check = signal => { if (signal?.aborted) throw new DOMException('Recovery cancelled; tag remains paused', 'AbortError'); };
  async function validateSource(input, source) {
    const backup = Uint8Array.from(input), report = JSON.parse(JSON.stringify(source));
    need(backup.length === SIZE, 'Choose the original complete tag backup (.bin), 512 KiB in size.');
    need(!backup.subarray(0, LIMIT).every(b => b === 0) && !backup.subarray(0, LIMIT).every(b => b === 255), 'The selected backup has no usable original application.');
    need(report.apply === true && report.verified === false && report.cpuKeptHalted === true &&
      report.chipId === '026255' && report.jedecId === 'eb6013' && report.bridgeVersion === '1.6' &&
      report.applicationBytes === LIMIT && [0x2c, 0x382c].includes(report.protectionOriginal), 'Unsupported failed-install recovery report.');
    const validHash = hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
    need(validHash(report.backupSha256), 'Missing original-backup checksum in the recovery report.');
    need(await F.digest(backup) === report.backupSha256, 'This backup does not match the original backup from the failed installation. Choose that original file.');
    let uidHash = report.flashUidSha256;
    if (report.flashUid) {
      need(typeof report.flashUid === 'string' && /^[0-9a-f]{32}$/.test(report.flashUid) &&
        !['00'.repeat(16), 'ff'.repeat(16)].includes(report.flashUid), 'Invalid target identity in the recovery report.');
      uidHash = await F.digest(Uint8Array.from(report.flashUid.match(/../g), b => parseInt(b, 16)));
      if (report.flashUidSha256) need(uidHash === report.flashUidSha256, 'Recovery target identity checks disagree.');
    }
    need(validHash(uidHash), 'Missing target identity in the recovery report.');
    if (report.programmerSha256) need(validHash(report.programmerSha256), 'Invalid programmer identity check.');
    return {backup, proof: Object.freeze({backupSha256: report.backupSha256, flashUidSha256: uidHash,
      programmerSha256: report.programmerSha256 || null, protectionOriginal: report.protectionOriginal})};
  }
  function recoveryOrder(original, current) {
    need(original.length === SIZE && current.length === SIZE, 'Incomplete tag reads; recovery stopped.');
    need(D.equal(original.subarray(LIMIT), current.subarray(LIMIT)), 'The tag’s factory data differs from the original backup. Stop and send the report to Gerard.');
    return [...Array.from({length: LIMIT / SECTOR - 1}, (_, i) => (i + 1) * SECTOR), 0]
      .filter(offset => !D.equal(original.subarray(offset, offset + SECTOR), current.subarray(offset, offset + SECTOR)));
  }
  async function recoverApplication(reader, input, source, options = {}) {
    const {signal, apply = false, resetAfter = true, resetWireDisconnected = false,
      progress = () => {}, onEvent = () => {}} = options;
    const {backup, proof} = await validateSource(input, source);
    need(resetWireDisconnected, 'Remove the wire connecting GP2 to the tag’s RST pad before connecting the programmer.');
    need(reader.baudRate === 921600, 'Recovery uses 921600 baud. Reconnect through the recovery page.');
    const flash = new F.FlashSession(reader), report = {webRecoveryRevision: D.revision, apply, verified: false,
      backupSha256: proof.backupSha256, baudRate: reader.baudRate, attemptedSectors: [], restoredSectors: [],
      cpuHaltVerified: false, cpuResetAttempted: false, cpuResetVerified: false, events: []};
    const event = (name, details = {}) => {
      report.events.push({event: name, ...details}); try { onEvent(name, details); } catch (_) {}
    };
    let failure = null, imageVerified = false, protectionVerified = false;
    try {
      check(signal);
      need((await reader.bridge.status()).version === '1.6', 'This recovery requires programmer v1.6.');
      if (proof.programmerSha256) need(await F.digest(new TextEncoder().encode(reader.bridge.device.serialNumber || '')) === proof.programmerSha256,
        'Choose the RP2040 programmer used for this failed installation.');
      const identity = await reader.activateRecovery(options);
      need(identity.chipId === '026255', 'The connected tag is not the expected chip.');
      need(D.equal(await reader.read(0x602, 1, signal), Uint8Array.of(5)), 'Could not confirm that the tag is paused.');
      report.cpuHaltVerified = true;
      need(D.hex(await flash.spi([0x9f], 3)) === 'eb6013', 'The connected tag has an unexpected flash chip.');
      const uid = await flash.spi([0x4b, 0, 0, 0, 0], 16);
      need(D.equal(uid, await flash.spi([0x4b, 0, 0, 0, 0], 16)) && await F.digest(uid) === proof.flashUidSha256,
        'This is not the tag from the failed installation. Recovery stopped.');
      const current = await flash.fullRead('Checking tag (pass 1)', signal, progress);
      need(D.equal(current, await flash.fullRead('Checking tag (pass 2)', signal, progress)), 'The two tag reads differ. Recovery stopped before writing.');
      await flash.ready(true);
      const observedProtection = await flash.status(); report.protectionObserved = observedProtection;
      need((observedProtection & ~0x407e) === (proof.protectionOriginal & ~0x407e), 'Unexpected protection state; recovery stopped.');
      await reader.verifyTransport();
      const order = recoveryOrder(backup, current); report.plannedSectors = order;
      event('recovery_plan_verified', {sectors: order.length});
      if (!apply) { report.checkPassed = true; }
      else {
        check(signal);
        need(D.equal(uid, await flash.spi([0x4b, 0, 0, 0, 0], 16)), 'The tag changed before recovery.');
        await flash.ready(true);
        const liveProtection = await flash.status();
        need((liveProtection & ~0x407e) === (proof.protectionOriginal & ~0x407e), 'Unexpected protection state; recovery stopped.');
        flash.allowWrites = true; flash.protection = proof.protectionOriginal;
        await flash.setStatus(proof.protectionOriginal & ~0x407c); flash.unlocked = true;
        for (let i = 0; i < order.length; i++) {
          check(signal); const offset = order[i];
          need(D.equal(await reader.read(0x602, 1), Uint8Array.of(5)), 'The tag is no longer paused.');
          report.attemptedSectors.push(offset); event('recovery_sector_attempted', {offset});
          await flash.writeSector(offset, backup.subarray(offset, offset + SECTOR), current.subarray(offset, offset + SECTOR), true);
          report.restoredSectors.push(offset); event('recovery_sector_verified', {offset});
          progress({phase: 'Restoring original firmware', done: (i + 1) * SECTOR, total: order.length * SECTOR});
        }
        need(D.equal(await flash.fullRead('Verifying original firmware', signal, progress), backup), 'The complete restored tag does not match the original backup.');
        await reader.verifyTransport(); imageVerified = true; event('original_image_verified');
        await flash.restoreProtection(); need(await flash.status() === proof.protectionOriginal, 'Original protection did not verify.');
        protectionVerified = true; event('original_protection_verified');
        if (resetAfter) {
          report.cpuResetAttempted = true;
          const warnings = await reader.restore(); report.cleanupWarnings = warnings;
          need(warnings.length === 0, 'Original image verified, but the final restart did not verify. Save the report.');
          report.cpuResetVerified = true;
        }
        report.verified = true;
      }
    } catch (error) {
      failure = error; event('recovery_failed', {message: error.message});
      if (error.transportDiagnostic) report.transportDiagnostic = error.transportDiagnostic;
      if (error.sectorDiagnostic) report.sectorDiagnostic = error.sectorDiagnostic;
    } finally {
      if (failure && flash.protection !== null && !protectionVerified) {
        try {
          await reader.resynchronize();
          await flash.restoreProtection(); need(await flash.status() === proof.protectionOriginal, 'Protection restore did not verify.');
          protectionVerified = true;
        } catch (error) { report.protectionError = error.message; }
      }
      if (!report.cpuResetAttempted && reader.paired) {
        const warnings = [];
        for (const operation of [() => reader.bridge.output(0x12), () => reader.io.settle(),
          () => reader.io.send(D.encode([0xff])), () => reader.reg(0x0d, [1]), () => reader.reg(0xb3, [0]),
          () => reader.io.port.setSignals({dataTerminalReady: false, requestToSend: false})]) {
          try { await operation(); } catch (error) { warnings.push(error.message); }
        }
        report.cleanupWarnings = warnings;
        if (warnings.length && !failure) { failure = new Error('Recovery cleanup did not verify. Save the report.'); report.checkPassed = false; report.verified = false; }
      }
      report.imageVerified = imageVerified; report.protectionVerified = protectionVerified;
      report.cpuKeptHalted = report.cpuHaltVerified && !report.cpuResetAttempted;
    }
    if (failure) { failure.report = report; throw failure; }
    return report;
  }
  async function restoreAndInstall(reader, input, source, application, options = {}) {
    const {backup, proof} = await validateSource(input, source);
    const chosen = application ? await F.validateBinary(application) : null;
    let recovery;
    try {
      recovery = await recoverApplication(reader, backup, source, {...options, resetAfter: !chosen});
      if (!options.apply || !chosen) {
        if (chosen) recovery.applicationSha256 = chosen.firmwareSha256;
        return {operation: chosen ? 'restore_and_install' : 'restore_original', verified: recovery.verified,
          checkPassed: recovery.checkPassed || false, recovery};
      }
      const installation = await F.installApplication(reader, chosen.application, {...options, apply: true,
        saveRecoveryBackup: false, conservative: true, haltOnly: true, pulseReset: false,
        expectedBackupSha256: proof.backupSha256, expectedFlashUidSha256: proof.flashUidSha256,
        expectedProtection: proof.protectionOriginal});
      return {operation: 'restore_and_install', verified: true, recovery, installation};
    } catch (error) {
      error.recoverySession = {operation: chosen ? 'restore_and_install' : 'restore_original', verified: false,
        recovery: recovery || error.report, installation: recovery ? error.report : null, error: error.message};
      throw error;
    }
  }
  const api = {validateSource, recoveryOrder, recoverApplication, restoreAndInstall};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FirmwareRecovery = api;
})(globalThis);
