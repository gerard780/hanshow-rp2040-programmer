# Temporary browser recovery 2026-10-13.4

A separate temporary support page recovers the interrupted tag directly in the
browser. The user selects the original backup and can keep the original firmware,
install included D9, or select another application `.bin`. Report fields and
recovery speed are preset; backup/programmer/tag guards use hashes. No customer
backup, full report, raw device identifier, backend or upload is included.

The original image and protection verify before the optional application stage;
the CPU stays halted across both stages and resets only after final full-image
and protection verification. Both stages use conservative 64-byte programming at
921600 baud. Users disconnect GP2 from RST before serial connection to prevent
host-driver reset pulses. Existing RP2040 v1.6 firmware is unchanged.

Validation: eight new recovery state cases and Chromium end-to-end support-page
checks, including actual included D9, custom firmware, original-only restoration,
wrong backup/hardware, failed restoration/protection and one final reset. Existing
protocol and Chromium read/write/discovery and dumper-only tests passed. Physical
use remains unverified. The included D9 matches the latest gist revision
`e2c08f926a6be2b5d51863aea84e235d94b46cfe`.

# Web tools 2026-10-13.3 — serial acknowledgements and original-backup recovery

Browser writes on an unstable serial link could fail sector verification and leave stale serial bytes that disrupted recovery. This update acknowledges each 60-byte encoded chunk, resynchronizes before recovery and protection restoration, and records attempted sectors and mismatch diagnostics. Browser writes require 1.5 Mbaud or 921600 baud, selected before opening the SWS port; 2 Mbaud remains available for readback and read-only checks.

`recover_application.py` restores an interrupted 128 KiB application from its original full backup and failed browser report. It verifies the backup SHA-256, target flash UID, matching current snapshots and preserved factory data, uses 64-byte programs at 921600 baud, and requires full-image verification plus original protection before resetting the CPU. Disconnect GP2 from tag RST for this recovery command; serial drivers can toggle reset during port open. See docs/RECOVERY.md.

Validation: 46 browser protocol/state cases, 40 Python cases, generated HTML checks and simulated Chromium tests for both URLs passed. The reported fifth-sector failure sequence is covered by a simulated restoration test. Successful physical browser installation/recovery and physical use of the new recovery command remain unverified; the original physical cause is unresolved.

RP2040 v1.6 source and UF2 are unchanged. Both standalone HTML files contain all browser resources. No backend, factory backups, field-report identifiers or unreviewed hardware designs are included.

# Web tools 2026-10-13.2 — single `.bin`, optional backup and discovery logs

Recipients can now select one application `.bin`; the browser validates its
KNLT header/CRC, pads locally and builds the per-tag flash plan from two fresh
matching full reads. No JSON, auxiliary binaries or Python preparation needed.

Saving a full recovery backup is checked by default and can be unchecked.
Skipping saving avoids the file dialog and disk backup; preservation reads,
application-only boundaries, sector-zero-last programming, blank/whole-flash
verification, protection restoration and memory rollback still run. Failed
unsaved recovery offers an emergency original snapshot download while open.

The original URL is dumper-only; the complete tool is hosted at `/tools/`.
Discovery readers display D8/D9 Bluetooth status, live UART logs and validated
D9 journal history from a saved readback. Only read-only discovery STATUS
requests are sent. D9 single-bin plans recognize the embedded journal descriptor
and initialize/preserve its reserved sector.

Existing v1.6 RP2040 firmware is sufficient and unchanged. Single-bin, guarded
flashing/readback and Chromium UI checks passed. The published unified and 437
v7 `.bin` formats pass validation; physical browser writes remain untested.
[Browser instructions](../firmware-dumper/README.md) cover both backup options.
Rollback is the earlier web release HTML; tag recovery uses its own saved backup.

# Web tool 2026-10-13.1 — application flashing (experimental)

The single HTML now supports guarded application flashing as well as backups.
It requires the existing v1.6 RP2040 UF2; programmer source and UF2 are unchanged.
Select the four prepared same-tag plan files, choose a recovery backup file,
and explicitly acknowledge application replacement to enable writes.

Before unlock, two complete reads must match the plan and the saved recovery
file must be closed/reread and verified. The browser preserves upper flash,
writes sector zero last, blank-checks and verifies each sector and the entire
expected image, restores protection, and attempts original-byte recovery on
failure/cancellation. Unverified recovery/protection keeps the CPU halted.

Nine new flash-state cases, 18 existing readback cases and Chromium UI checks
pass. Physical browser writes and complete 437 installation remain untested.
See [browser instructions](../firmware-dumper/README.md), [flashing](FLASHING.md)
and [validation](VALIDATION.md). No backend, external scripts, private tag dumps
or unreviewed CAD files are required/included. To revert the browser feature,
use the read-only standalone HTML from the v1.6 release; keep the same programmer
UF2. Tag recovery always uses your own same-tag saved backup.

# Programmer v1.6 — reconnect and guarded application writes (experimental)

Repeated connections after legacy SWS activation previously stalled when a
host selected the already-active address width. v1.6 acknowledges that no-op
while retaining the guards on genuine width changes. Python and browser hosts
read the current width first, including for compatibility with v1.5.

The reported `Timeout! Flash status 0xff!` originates in the pinned upstream
Python CLI's incorrect SPI status transaction. Upgrading the UF2 alone does
not fix that CLI. The new `flash_application.py` uses the existing corrected
status backend, two-byte protection writes and exact protection restoration.
Use the application's prepared same-tag plan as described in
[the flashing guide](FLASHING.md). It requires two new matching full backups,
checks application hashes/CRC and preserved data, writes changed application
sectors below `0x20000` with sector zero last, blank-checks/reads each sector
and verifies the complete expected flash before reset. Failure attempts
conservative restoration; unresolved recovery/protection keeps the CPU halted.

The released UF2 passed three physical original-byte rewrites of a mixed-data
sector on one `026255` / `eb6013` tag. Two fast runs took 1.176 s and 1.162 s;
all 512 KiB matched the backups afterward, protection/reset verified and no
new transport faults occurred. Repeated width requests and active/invalid
width rejection passed. The installer passed physical dry-run preflight.
Host/PIO, guarded-write/recovery, browser protocol/UI, compiled USB descriptor,
UF2 and standalone generation checks passed. See [validation](VALIDATION.md).

The complete experimental 437 installation and display behavior remain
physically untested. This release does not establish that the earlier physical
browser mismatch is resolved; physical browser, Windows write and 826x hardware
tests are still outstanding. It includes no tag dumps or unreviewed CAD files.

The UF2 installs on the RP2040-Zero programmer. Nebular display application
firmware is supplied separately. Source, UF2, standalone browser HTML and
checksums accompany this experimental prerelease. Rollback for a programmer
regression is the published v1.5 UF2 via BOOTSEL; retain current host tools for
their v1.5 reconnect fix. Tag recovery uses your fresh same-tag backups, never
another tag's dump.
