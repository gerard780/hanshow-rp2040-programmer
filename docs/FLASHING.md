# Application flashing on 026255 / EB6013

Use `flash_application.py` from the repository root with the application
package's `flash-plan.json`. This experimental installer is limited to chip
`026255`, flash `EB6013`, 512 KiB main flash and known status `0x002c` or
`0x382c`. Readback supports more chips; writing does not.

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
