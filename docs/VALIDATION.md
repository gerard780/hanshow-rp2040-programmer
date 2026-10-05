# Programmer validation

## Existing physical transport checks

The earlier bench implementation completed two matching full 512 KiB native
block reads on 2 October 2026. Both matched the legacy byte-by-byte read, with
zero transport faults and verified CPU reset/release. Total time was about
120.6 seconds per full block read on that setup; reading itself took about
117.3 seconds. These were checks of the legacy three-byte SWS path.

Native request checks rejected zero/oversized counts, invalid index, missing
read header and concurrent starts. Cancellation preserved the captured partial
data; subsequent 1-, 4096- and 4137-byte reads matched the baseline.
The programmer was subsequently used for guarded Nebular 154 wired application
installation/readback. Private dumps and raw bench records are not included.

## Public integration and broader reader

The public firmware keeps SWS, reset and the optional UART. It retains explicit
2/3-byte SWS header selection for the 826x/825x-style reader backends. The host
probes repeated chip/JEDEC responses and flash size, requires matching nonblank
sample reads, and verifies repeated captures and reset release. It rejects
out-of-range sizes and labels partial reads separately from complete flash.

A clean source build passed with the pinned Pico SDK and GCC toolchain.
Host tests cover other chip IDs/manufacturers, capacity/address bounds,
inconclusive/mismatched probes, SPI release, reset attempts after cleanup faults,
and both address-width selections. Syntax and CLI checks passed.
These do not establish physical operation on every Telink chip, on the 826x
backend, or on newer families with different register maps.

The new reader also passed a physical 4 KiB probe on a known Nebular 154
using the existing bench bridge v1.2 on 4 October 2026. Auto probing selected
the 825x backend, read chip response `026255` and JEDEC ID `eb6013`, and
detected 512 KiB of flash. Two preliminary samples and two captures matched,
with zero transport faults and verified reset release. This was a partial
read (`complete_flash: false`), not a new full factory backup. Neither tag
flash nor programmer firmware was changed for this check. The public v1.3
UF2 and its two-byte address mode have not yet been installed and checked
on physical hardware.

[Build provenance](BUILD-PROVENANCE.json) and the [manifest](../dist/manifest.json)
record public source and firmware hashes. `SHA256SUMS` checks package files.

The UART interface opened successfully in earlier checks, but useful tag console
text and tag reception were not fully verified. USB VID/PID `cafe:4012` is a
prototype identifier, not a registered product allocation.

## Public v1.5 checks

The combined v1.5 firmware builds with the pinned SDK/toolchain and no compiler
warnings. Eleven reader/PIO tests cover broad chip probes, older bridge baud
compatibility, explicit fallback, both SWS widths and all byte values over
synthetic pulse timings, including missing/stuck end pulses and PIO capacity.
Fourteen guarded-write tests cover protection boundaries, matching live backups,
blank-erase checks, partial-program recovery and keeping the CPU halted if
recovery fails. Browser tests cover repeated reads, mismatch/cancellation,
USB/serial identity and selecting three-byte framing after an 826x session.
Compiled descriptor checks verify the CDC/vendor layout, WinUSB binding and
that the distributed UF2 reconstructs the built firmware.

Bench v1.4 results, including the 2 Mbaud sweep and original-byte sector
rewrites, are summarized in [development status](DEVELOPMENT-STATUS.md).
The combined v1.5 UF2, successful physical browser capture, 826x path, additional specimens
and full-image installation still need physical validation. Software tests use
simulated data and do not change a connected tag.

## Browser revision 2026-10-05.2

Two physical browser attempts with bench v1.4 at 921600 baud failed full
verification in the 4 KiB block starting at `0x035000`. The earlier error
reported the block start, not the exact differing byte. The cause remains
unconfirmed; a fault-free bridge status alone does not establish correct data.

This revision makes baud and divider calibration agree with the Python
reader: v1.4/v1.5 default to 2 Mbaud, with explicit 1.5 Mbaud and 921600 options.
It removes the browser's 25 ms CDC drain after native block completion,
matching Python's completed-block path. It verifies the requested bridge baud,
logs the final divider and reports exact mismatch addresses/counts/byte pairs.
A single diagnostic reread reports whether the failed block matches either
pass; it never makes a failed backup available for download.

Simulated transport and Chromium tests pass for selected baud/divider settings,
full-image downloads, a mismatch inside the reported `0x035000` block,
cancellation, cleanup and standalone HTML operation. The revised browser still
needs physical validation on the affected tag; these checks do not establish
that the reported failure is resolved.

## Browser revision 2026-10-05.3 — CH340

CH340/CH341 UART mode uses Web Serial only, 921600 baud and calibrated legacy
SWS samples in 256-byte flash blocks. The page offers separate adapter wiring,
checks the selected UART USB ID, and defaults its optional RTS reset pulse off.
It waits for each waveform chunk's echo before queuing the next, including
activation traffic, to preserve complete SWS words without a Web Serial flush.
The RP2040 USB/serial pairing and native block path remain separate.

Serial simulations exercise complete two-pass reads over fragmented replies,
mismatches, diagnostic rereads, invalid samples, wrong adapters, unsupported
flash, cancellation and cleanup. A delayed-echo test rejects queuing the next
waveform chunk before the previous echo arrives. Chromium checks run without
WebUSB and validate CH340 filters, wiring selection, baud, real binary/report
downloads, wrong-port rejection, cancellation, closed handles and mobile layout.
The RP2040 browser regression checks also pass. These tests use synthetic
64 KiB CH340 flash data and 512 KiB RP2040 data, without opening a physical port.

The legacy CH340 UART/SWS protocol has earlier physical readback evidence; the
new browser CH340 path still needs testing on the physical adapter and tag.
No tag flash erase, program, unlock or status-write path was added.
