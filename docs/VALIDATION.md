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

## Public v1.3 and broader reader

The public firmware keeps SWS, reset and the optional UART. It adds explicit
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
