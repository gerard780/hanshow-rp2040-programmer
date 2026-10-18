# Application flashing on 026255 / EB6013

## Simple D10 installer for Nebular 437

Open the **[D10 installer](https://gerard780.github.io/hanshow-rp2040-programmer/d10/)**
in desktop Chrome or Edge. D10 is included. Connect the v1.6 RP2040, choose its
SWS port, then click **Save backup & install D10** and choose a new backup file.
The page reads the tag twice, matches the captured 437 product record and one
of the three known complete native waveform banks, saves and rereads the full
backup, then writes and verifies the application. Keep the tag powered and the
page open until completion. The connection uses 460800 baud (half of 921600)
with conservative writes. No programmer update is needed beyond v1.6.

Backup reads and application-sector writes allow up to three attempts each
(the first attempt plus two retries). Every backup retry starts with two fresh
full reads. A write retry first verifies the paused tag and two matching reads
of the affected sector; already correct contents need no additional erase.
Unreliable retry checks or exhausted attempts stop forward writing and trigger
the existing recovery path. Stop safely cancels retries and allows recovery
to finish. Retries can increase the total time.

The included firmware is pinned to the [D10 gist](https://gist.github.com/gerard780/4c4f7510a67268b1721486249fa121b2),
SHA-256 `cea41f2aad7b9b0f6a4d3a89be401764a6abc5d50ebb167c628625f949ff1927`.
The page links to the matching D10 display controller after installation.
Existing valid discovery journals are preserved. The tag tests P0–P3 itself;
successful flashing does not establish visible display success.

This normal installer does not use a personal recovery link or require an old
backup upload. For an interrupted installation with unverified recovery, follow
the [recovery instructions](RECOVERY.md) first. Physical use of the new guided
page remains unverified; browser tests use simulated devices.

## General application installer

Use the [read/write/discovery tool](https://gerard780.github.io/hanshow-rp2040-programmer/tools/)
with a **single application `.bin`**, or `flash_application.py` with the
application package's prepared same-tag plan. Both write paths remain
experimental and limited to chip `026255`, flash `EB6013`, 512 KiB main flash
and known status `0x002c` or `0x382c`. Readback supports more chips; writing does not.

## Single-bin browser workflow

Select the application `.bin` supplied for your tag. The browser checks its
KNLT header/length/CRC and raw or FF-padded form, reads the tag twice, and builds
the per-tag expected image and recovery plan automatically. No additional
JSON/files or Python preparation are needed. Raw applications are FF-padded
locally to whole 4 KiB sectors. Full-flash dumps and RP2040 UF2 files are rejected.
The format check cannot prove display/board compatibility.

**Save a full recovery backup before flashing** is enabled by default. Uncheck
it to skip saving a backup file; the two reads required for preservation,
planning and verification still run. Original bytes stay in memory for
in-session rollback. With saving enabled, the chosen full backup file must be
closed, reread and verified before unlock. Check firmware is a dry run; Flash
application additionally requires the application acknowledgement.

Browser writes accept **460800, 921600 or 1500000 baud**. The simple D10 page
uses 460800; the full tools offer 921600 or 1.5 Mbaud for writes, selected before
opening the SWS port. 2 Mbaud remains available for readback and Check firmware. Serial chunks
are acknowledged individually; recovery clears interrupted framing and stale
receive bytes before verifying the halted CPU and target UID. Recovery retains
the selected baud because reopening the serial port can toggle reset. If recovery
fails, use the [original-backup recovery instructions](RECOVERY.md) after saving the
emergency original backup and failed-install report. A normal installation is
not a recovery of the original image.

Keep the page/power connected during writes and recovery. When unsaved recovery
fails, the CPU stays halted and the page offers an emergency original-backup
download. Save it before closing/reloading the page. Without a saved backup,
recovery after a closed page or lost power may not be possible. Firmware/backup
files and operation reports stay local. See [browser instructions](../firmware-dumper/README.md).
The existing RP2040 v1.6 UF2 is sufficient; no new programmer firmware is needed.
The original root URL is now dumper-only; flashing and discovery readers are at
`/tools/`. Raw D9 applications with the exact embedded journal descriptor
initialize the reserved journal when needed and preserve existing valid-header
journal contents on reflash. Ordinary applications retain their normal FF padding.

## Why the older flasher times out

The pinned upstream `TLSR825xComFlasher.py` remains unmodified for reproducible
readback. Its erase/write CLI calls `FlashReady()` without the SPI response
clock or auto-read setup and can report `Timeout! Flash status 0xff!` on a
ready flash. Updating the RP2040 alone cannot repair that Python routine.
The installer uses `tools/speed/flash_backend.py` instead. It reads status
opcodes `0x05` and `0x35` correctly, writes both status bytes and clears only
the MID1360EB BP mask `0x407c`, preserving other bits. It restores the exact
original protection before resetting the CPU. No separate password or chip
unlock sequence was needed in the tested original-byte writes.

## Prepare and check the plan

Retain your own complete, matching same-tag backups. Use the `prepare_flash.py`
supplied with your target application package; it checks that package's
firmware and accepted factory product record. For example, from that package:

```sh
python3 prepare_flash.py --before /path/to/YOUR-verified-full-backup.bin --output /path/to/flash-plan
```

Keep all four generated files together: `flash-plan.json`,
`application-padded.bin`, `expected-full-flash.bin` and
`recovery-application.bin`. The installer checks the application header, CRC,
hashes, padding, region limits and recovery bytes. It takes two new durable
full backups and requires both to match the plan's original-backup hash.
An old or different tag's plan is rejected before unlock. Prepared files and
capture directories contain per-tag data; keep them private.

The four-file preparation above is for the Python installer. Browser users
select the single application `.bin` directly. Browser recovery uses 64-byte
programs and legacy status reads at the selected baud; Python recovery below
also switches to 921600 baud. Physical browser writes remain untested.

From this programmer repository after installing `requirements.txt`:

```sh
# Dry run: read/verify only. Use a new output directory for every invocation.
sudo .venv/bin/python flash_application.py \
  --plan /path/to/flash-plan/flash-plan.json \
  --port /dev/serial/by-id/YOUR_ZERO_SWS_INTERFACE_if00 \
  --bridge-serial YOUR_ZERO_SERIAL --output private/flash-check

# After reviewing the dry run, explicitly enable application writes.
sudo .venv/bin/python flash_application.py \
  --plan /path/to/flash-plan/flash-plan.json \
  --port /dev/serial/by-id/YOUR_ZERO_SWS_INTERFACE_if00 \
  --bridge-serial YOUR_ZERO_SERIAL --output private/flash-install --apply
```

Replace the port and serial ID with your programmer's SWS interface. On
Windows use its SWS `COM` port and your virtual environment's Python, omitting
`sudo`. Hardware testing for this release was on Linux; Windows write tests
have not been run. Use one application/backup plan for both commands. If the
live flash changes after a reboot, make a fresh verified backup and regenerate
the plan. `--baud 1500000` selects the explicit fallback. Supported bridges
are v1.4, v1.5 and v1.6; use the v1.6 UF2 for the reconnect correction.

## Write and recovery behavior

Only changed 4 KiB application sectors below `0x20000` are erased; sector zero
is last. The installer checks each live sector against its saved original,
checks the erased sector for all-FF bytes, programs 256-byte pages and verifies
each sector. It then compares all 512 KiB against the prepared expected image,
including preserved factory/calibration/identity data. There is no mass erase.

A failed erase/program attempts restoration of every attempted sector from
the fresh backup using conservative 64-byte programs at 921600 baud, again
with sector zero last. The journal records failure even if recovery succeeds.
CPU reset requires complete-image verification and restored protection. If
recovery or protection cannot verify, the CPU stays halted; retain the capture
folder and resolve recovery before power cycling or using another writer.

`application-install.json` records the outcome. A successful dry run reports
`apply: false`; it has not installed anything. A successful install reports
`apply: true`, `verified: true` and the verified sectors, or `already_installed`
when the expected bytes were present and no writes were needed.

Physical evidence covers original-byte sector rewrites and installer dry-run
preflight on one bench tag. Installing the complete experimental 437 image
and validating its display behavior remain untested. See [validation](VALIDATION.md).
