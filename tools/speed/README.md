# Guarded flash and speed tools

These are the updated bench tools for the known `026255` / `eb6013` Nebular
path. They support bridge v1.4/v1.5 and default to **2 Mbaud**, with explicit
`--baud 1500000` fallback. They are separate from the broad, read-only
[readback helper](../../readback.py). Measurements and hardware limits are
in [development status](../../docs/DEVELOPMENT-STATUS.md).

`flash_backend.py` uses 256-byte page programs and native status reads instead
of unconditional 50 ms status sleeps. Writes are disabled by default. It
checks the application region, known protection layout and a matching live
sector before an erase/program, requires an explicit same-byte rewrite flag,
and verifies readback. This is an experimental sector API, not a full-image
installer.

`write_validation.py` saves two durable matching 512 KiB backups, checks
chip/flash identity, then optionally erases and restores the **original bytes**
of one populated nonzero application sector. It verifies the blank erased
sector, final sector and entire flash, restores protection and resets the CPU.
On a rewrite failure it attempts conservative recovery; if recovery or
protection cannot verify, it leaves the CPU halted and reports failure.
It does not install different firmware. Full-image installation is untested.

From the repository root, after installing `requirements.txt`:

```sh
# No erase/program without --apply; output directories must be new.
sudo .venv/bin/python tools/speed/write_validation.py \
  --reader vendor/TLSR825xComFlasher.py \
  --port /dev/serial/by-id/YOUR_ZERO_SWS_INTERFACE_if00 \
  --bridge-serial YOUR_ZERO_SERIAL --output write-check
```

`--apply` explicitly enables original-byte sector rewrites. `--baud 1500000`
selects the fallback; it is not automatic. Higher rates had intermittent read
errors in the earlier experiments. Always retain matching independent backups.
The known-chip tools restore and verify three-byte addressing on public v1.5
before opening serial, including after the broad helper selected 826x framing.

`benchmark_readback.py` measures known-chip reads. `hardware_check.py` checks
native cancellation and byte/block comparisons against your own full backup.
`status_benchmark.py` compares status-read paths without flash writes. These
require the pinned vendored reader, the selected board/port and new output
paths. No private tag dumps or bench device identifiers are distributed here.

Offline checks:

```sh
.venv/bin/python -m unittest discover -s tools/speed/tests -v
.venv/bin/python -m unittest discover -s tests -v
```

Tests cover factory boundaries, write gating, live mismatches, ignored erases,
partial-program recovery, failed-recovery halt and backup-only operation.
Simulation checks do not physically validate the combined public v1.5 UF2.

## Legacy `Flash status 0xff` report

On the known `026255` / `eb6013` path, the unmodified vendored flasher's
`FlashReady()` does not launch the SPI status read. Its `0xff` timeout can occur
while correct status reads report a ready, protected flash. The guarded
`flash_backend.py` implements the corrected path: status opcodes `0x05` and
`0x35`, an initial response clock and SPI auto-read mode. Unlock uses the
MID1360EB driver's two-byte status write and clears only BP mask `0x407c`,
preserving other status bits and restoring the saved protection afterward.
Do not bypass the timeout or replace the whole status register blindly.

A physical original-byte sector test passed using the exact public v1.5 UF2;
see [validation](../../docs/VALIDATION.md). `write_validation.py` verifies this
write path with backups and restoration; it does not install
`application-padded.bin`. `flash_backend.py` is the sector API for a guarded
installer, not a standalone image-flashing command. Installing a different
437 application still requires a complete same-tag backup, application-only
erases, sector zero last and verification of the entire expected flash.
