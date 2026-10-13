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
