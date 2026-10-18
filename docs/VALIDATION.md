# Programmer validation

## Read and sector-write retries — page 2026-10-18.4

Backup retry tests cover transient and persistent mismatches, partial native
read errors, changed UID/protection, failed resynchronization, persistent fault
counters, cancellation and invalid limits. No rejected attempt is saved or
used for programming; a successful retry requires a complete new matching pair.

Write retry tests cover damaged programmed data, transient verification errors
resolved without another erase, ignored erases, bounded exhaustion followed by
original-image recovery, inconsistent retry readback, faults, changed identity
or protection, cancellation and invalid limits. The original single-attempt
tests remain passing. Chromium installs the actual D10 binary after an injected
read mismatch and an injected write mismatch, then verifies the complete image,
saved original backup, sector-zero-last order and original protection. These
are simulated-device results; no physical bench was accessed.

## Lower-rate D10 installer — page 2026-10-18.3

The readback timing tests include 460800 baud with divider 104. Guided-page
Chromium checks verify that the port, installation report and recovery keep
that rate while retaining backup persistence, rejected mismatched/blank reads,
complete-image preservation and cancellation behavior. The v1.6 source accepts
SWS line coding from 340000 to 3000000 baud, so 460800 needs no bridge firmware
change. These simulated tests do not establish physical reliability at the
lower rate or resolve the cause of the reported backup disagreement.

## Backup diagnostics — page 2026-10-18.2

The comparison tests distinguish matching nonblank reads, byte disagreements
across sectors, matching blank reads and incomplete captures. The existing
single-bin mismatch test now checks the exact failure address and saved
diagnostic fields as well as zero status writes/erases. Chromium exercises
both differing and matching blank reads, verifies their downloadable reports,
and checks that neither case saves an accepted backup or writes flash.
These checks use simulated devices and do not diagnose the physical cause of
the user-reported preflight failure.

## Guided D10 page — 18 October 2026

The D10 target/pinning tests and existing browser-backend test files pass.
The guided-page Chromium tests use fake USB/serial/flash devices and synthetic
factory-match metadata, while installing the actual pinned D10 application.
They verify a fresh saved/reread 512 KiB backup precedes erase, application
sector zero is last, the full expected image and protection verify, and all
bytes at/above `0x20000` are preserved. The backend retains its existing
journal initialization/preservation behavior.

Additional cases reject wrong product records, altered waveform packages,
failed backup writes/readback, wrong serial interfaces, unsupported browsers,
older programmers and damaged firmware. Cancellation after writes restores the
previous image. Unverified restoration/protection leaves the CPU halted and
disables normal retries. Mobile layout and self-contained resource loading
are checked. There was no bench access or physical D10/browser validation.

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

## Browser flashing revision 2026-10-13.1 — 13 October 2026

The standalone HTML adds a guarded application installer over the existing
v1.6 SWS/USB protocol. The RP2040 source and shipped UF2 are unchanged; the
UF2 hash remains `55a226a0...c454a51`.

Nine new flash-state test cases pass, covering successful two-sector installs,
saved-backup gating, read-only dry runs, stale plans, application/factory/page
boundaries, CRC/order validation, partial programming in sector zero,
cancellation with recovery, ignored erase, failed recovery, failed protection
restoration, unknown hardware and serial/USB pairing. A NOR flash emulator
executes the actual waveform packets, write-enable/protection rules and page
program bit transitions. The 18 existing readback protocol cases also pass.

Chromium tests exercise the generated single HTML's existing backup/download
flows, valid application-file selection, explicit write acknowledgement,
flashing with saved recovery bytes, result reports and a failed backup file
write that prevents all unlock/erase/program. Mobile layout and absence of
companion network resources are checked. Physical browser writes, Windows
hardware, and complete 437 application/display behavior remain untested;
no bench devices were modified for this browser release. The earlier v1.6
Python write evidence does not establish physical WebUSB flashing success.

## Single-bin and optional saved backup — revision 2026-10-13.2

The browser accepts raw and FF-padded KNLT/CRC application files and derives
the per-tag plan from two new matching 512 KiB reads. Saved recovery backups
are optional and enabled by default. Skipping the file-save step preserves
all read/region/blank-check/full-image/protection checks and in-session rollback.
An unsaved recovery failure retains an original snapshot for emergency download.

The published unified 1.54/2.66 `.bin` (129588 bytes) and experimental 437 v7
`.bin` (128068 bytes) passed the offline format/CRC validator, padding to the
128 KiB application limit. This does not physically validate installing them.
Eight new test cases cover raw/padded equivalence, near-limit sizes, malformed
files, auto-plan/upper-flash preservation, install/dry run without a saved file,
default save gating, mismatching reads with saving disabled, memory recovery
and unsaved failed-recovery snapshot retention. Existing guarded-flashing and
readback cases remain passing. Chromium UI checks exercise a single arbitrary
filename, default saved backup, disk-write failure, skipping with no save dialog,
operation reports and invalid-file rejection. Physical browser writes and full
437 display behavior remain untested. The RP2040 source/UF2 are unchanged.

## Split URLs and discovery readers — revision 2026-10-13.2

The original GitHub Pages root is dumper-only; the complete read/write/discovery
page is `/tools/`. Each is separately bundled, self-contained HTML using the
same unchanged v1.6 UF2. Root Chromium tests confirm flashing/discovery controls
are absent and backup/mismatch/cancellation/download behavior still works.

Seven discovery cases cover v1/v2 frame offsets/flags/signed temperature,
status-only Bluetooth requests, synchronous replies, overlap and timed-out/hung
writes, split UTF8 UART lines, D9 journal header/record CRCs and torn records,
driver-timeout flags, and D9 journal initialization/preservation. The decoder
follows the current D9 journal source; driver-timeout bit128 is a valid flag.
The newly built D9 discovery raw `.bin` passed the actual browser validator and
its embedded descriptor produced the required 128 KiB application/journal layout.

Full-tools Chromium tests cover status-only BLE reads, UART streaming without
serial commands/RTS reset, loaded journal records and session export alongside
single-bin saved/unsaved flashing and emergency backup recovery. These tests
use simulated devices. Physical browser writes, BLE/UART discovery hardware,
D9 installation/display behavior and Windows hardware remain untested.

## Browser transport and interrupted-write recovery — revision 2026-10-13.3

A field report for revision 2026-10-13.2 described two matching full backups,
four verified sectors, a later sector readback mismatch, failed recovery and
failed protection restoration at 2 Mbaud. The report does not distinguish a
programming fault from a corrupted readback and does not establish its physical
cause. Successful physical browser installation/recovery remains unverified.

Revision2026-10-13.3 acknowledges each 60-byte serial chunk before transmitting
the next, drains stale bytes and interrupted framing before recovery/protection
restoration, and requires 1.5 Mbaud or 921600 baud for browser writes. Readback/checks
retain 2 Mbaud. Baud is selected before opening the serial port; recovery does not
reopen it or pulse reset. Reports include attempted sectors, recovery sector
progress and sector mismatch diagnostics. RP2040 source and v1.6 UF2 are unchanged.

Four new software cases check chunk acknowledgement/early abort, the 2 Mbaud
write guard, the five-sector failure sequence with stale echo and complete
restoration, and failed resynchronization retaining the emergency backup with
CPU halted. Existing readback, flashing, single-bin and discovery tests pass.
Chromium smoke tests include the 2 Mbaud write guard, saved/unsaved flashing and
emergency backup downloads, with simulated devices only.

`recover_application.py` has six offline recovery tests covering original full
backup/report guards, changed factory-data rejection, sector ordering, complete
restoration before reset, a read-only check without reset/writes, wrong-UID
rejection and a partial recovery failure without reset. It uses the existing
conservative 64-byte/921600 baud backend and adds complete-backup/failed-report
identity guards. The recovery command itself has no physical hardware test.
No field-report device identifiers or private backups are published.

## Temporary browser recovery — revision 2026-10-13.4

A separate standalone support page restores an interrupted 437 application from
its original full backup and can install included D9 or a supplied `.bin` in the
same session. The page is bound to hashed programmer/tag identifiers and the
failed report's original-backup SHA256. It publishes no customer backup or full
report and has no backend/uploads. Included D9 is pinned to gist revision
`e2c08f926a6be2b5d51863aea84e235d94b46cfe`, binary SHA256
`dbec2a8f371a3638bbfc85b39ad94f0a8192d719db7e7a38b86939a32c68d06f`.

The recovery activation path halts the CPU without pulsing RST or writing the
reset register. GP2 must be disconnected before the serial port opens to avoid
host-driver control-line resets. Both stages use 921600 baud and 64-byte programs.
The first stage restores and verifies the complete original image/protection
without restarting; the second uses fresh matching reads and matching original
backup/target hashes before application writes. The only successful reset is
after final complete-image and protection verification. Failed new-app writes
use the restored original as their rollback image.

Nine recovery state cases cover backup/report guards, dry checks without
mutations/reset, wrong hardware/current reads/factory-data rejection, original
restoration, combined installation without an intermediate reset, cancelled or
failed recovery, original-image rollback on new-app failure, and failed
protection preventing the second stage/reset, and changed contents/protection between stages
preventing writes/reset. Target settle timers are shortened
in simulations; this does not model physical timing. Existing browser protocol
cases remain passing.

Chromium tests exercise the actual standalone page with included D9 and a custom
application, original-only restoration, wrong backup/programmer/tag rejection,
failed restore/protection, fixed speed, no reset during checks, one final reset,
full expected-image equality, report downloads, mobile layout and no companion
network resources. Physical browser recovery/installation remains unverified.
