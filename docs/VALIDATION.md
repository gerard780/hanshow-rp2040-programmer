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

## Physical v1.5 write investigation — 8 October 2026

The exact published v1.5 UF2 (`845d574f...dc0e7d`) was installed on the idle
bench RP2040-Zero and tested with one `026255` / `eb6013` tag. The unmodified
vendored `FlashReady()` repeatedly printed `Timeout! Flash status 0xff!`.
Correct SPI reads repeatedly returned SR1 `0x2c`, SR2 `0x00` on that specimen.
The legacy routine sends status opcode `0x05` but does not clock its response
or configure the SPI auto-read path; it does not obtain a valid status byte.

Using the existing guarded `flash_backend.py`, two fresh complete 512 KiB
backups matched. One nonzero-address 4 KiB sector was erased and restored to
its original bytes three times: once with 64-byte programs at 921600 baud and
twice with native status reads and 256-byte programs at 2 Mbaud. Each erase
was checked for all-FF contents, each rewrite verified, and the final complete
flash matched the original backups. Original protection `0x002c` and CPU reset
were restored, with no added transport faults. Native operations took 1.176 s
and 1.162 s, excluding full backups and activation. This selected sector
contained zero bytes; no claim of all-byte-pattern hardware coverage is made.
At the end of this v1.5 investigation, the programmer was retained on v1.5. Full 437 application
installation, the 437 display driver and other specimens remain untested.

A separate v1.5 host issue was reproduced after the preceding serial session:
unconditionally setting an already-correct three-byte address width stalls
because the firmware keeps SWS active across legacy DTR transitions. The
known-chip helper now reads the width first and avoids that unnecessary SET.
The host change passed the physical reconnect/write sequence. Real changes
from two-byte framing still require an idle bridge; this change does not
relax the firmware's active-session guard. Regression tests cover this case,
malformed width replies and the legacy/native status-read discrepancy.

The v1.5 investigation did not modify the vendor reader or UF2. Private captures, device identity,
and bench-only orchestration are excluded from the public package.

## v1.6 release validation — 8 October 2026

The exact v1.6 release UF2 (`55a226a0...c454a51`) was built from the pinned
SDK/compiler and installed on the bench while holding its shared test locks.
One `026255` / `eb6013` specimen passed three original-byte rewrites of mixed
application sector `0x8000`: 64-byte programs at 921600 baud, then two
256-byte-page runs at 2 Mbaud. Every erase was blank-checked and every sector
verified. Two complete 512 KiB backups and the post-write full read matched;
original `0x002c` protection and CPU reset verified, with zero new transport
faults. The specimen's application and factory data were preserved.

| Operation | Time |
| --- | ---: |
| Conservative sector rewrite | 6.310 s |
| Native sector rewrite, run 1 | 1.176 s |
| Native sector rewrite, run 2 | 1.162 s |
| Complete 512 KiB read | 29.43–29.45 s |

Rewrite times include live precheck, erase, blank check, programming and sector
verification, excluding activation and complete backups. This is one sector
on one specimen, not a long-term reliability or other-tag compatibility test.

Three repeated SET requests for the existing three-byte width succeeded after
the serial session. A real change to two-byte width during active SWS and an
invalid width were both rejected. The new application's installer passed a
physical **dry run** against two additional matching full backups. Its private
test plan used a CRC/padding-corrected copy of the current bench application
for preflight only; it performed no erase/program or protection changes.
No experimental 437 image was installed on this different-model bench tag.

Software checks passed: 34 guarded-write/status/installer tests, 11 readback/PIO
tests, 18 browser protocol cases, three compiled descriptor/UF2 checks and
Chromium UI smoke tests. Installer simulations include successful writes,
sector zero last, stale-plan rejection, ignored erases, partial-page recovery
including a failure in sector zero, failed recovery, protection-restore failure
and unexpected upper-flash changes. The standalone HTML embeds the same UF2
and passes the generated-file check without companion network resources.

Full 437 installation/display behavior, physical browser capture (including
the earlier `0x035000` mismatch), Windows hardware writes, 826x hardware and
additional tags remain untested. No private dumps, device IDs, test plans or
unreviewed CAD files are published. The bench programmer is retained on v1.6.
