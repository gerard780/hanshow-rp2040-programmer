# Current development status — 8 October 2026

v1.6 fixes repeated SWS address-width selection and adds a guarded application
installer with correct status polling/protection handling. The candidate UF2
passed physical original-byte erase/program tests on one `026255` / `eb6013`
bench tag, including complete-flash preservation and restored protection.
Current results and limits are in [validation](VALIDATION.md); application
instructions are in [flashing](FLASHING.md). The 437 full-image installation,
physical browser capture and 826x hardware path remain untested.

The earlier v1.4/v1.5 development notes below are historical.

## Historical development status — 5 October 2026

The public **v1.5 experimental** source and UF2 now combine the faster PIO
transport and browser USB descriptors from the bench prototype with the
public two-/three-byte SWS address selection. The Python readback helper,
guarded write/benchmark tools and browser dumper are included in this repo.
The combined UF2 is built and software-tested; the physical results below
were measured with the earlier bench v1.4 prototype on one tag.

## This morning's speed work

The bench RP2040-Zero runs an experimental v1.4 prototype with revised PIO
reply timing and block-capture setup. Its Python read and sector-write
validation tools now default to **2,000,000 baud**. The explicit fallback is
`--baud 1500000`; a failed capture is not silently retried at another speed.

On one known `026255` / `eb6013` tag with a 512 KiB flash, a 1 kΩ SWS resistor
and the existing 100 mm Dupont leads:

| Read setting | Mean time reading 512 KiB | Matching full captures in the baud sweep |
| --- | ---: | ---: |
| 921600 | 58.03 s | 1 / 1 |
| 1.5 Mbaud | 37.88 s | 1 / 1 |
| 2 Mbaud | 29.86 s | 6 / 6 |
| 2.5 Mbaud | 24.67 s | 5 / 6 |

Thirty additional sector reads matched at 2 Mbaud. The 2.5 Mbaud sweep had a
corrupted full capture, and separate 3 Mbaud repetition also produced corrupt
data and an aborted native read. The transport fault counter remained zero
for some incorrect captures; matching independent reads are still required.
These samples establish neither a long-term error rate nor compatibility
with other tags.

Two original-byte rewrites of the same populated 4 KiB application sector
passed at the 2 Mbaud default in **1.185 s and 1.182 s**, versus **6.388 s**
with conservative settings. Each fast operation included a live precheck,
blank-erase confirmation, programming and sector verification. Two full
backups and the final full-flash comparison matched the original; protection
and reset were restored. These operation timings exclude full backups and
activation. Full-image installation remains untested.

This is evidence from the separate bench prototype, not physical validation
of this repository's combined v1.5 UF2. The address-width support and later
transport changes are now both retained in the published source.

## Browser work from the previous evening

A separate browser dumper was also implemented, with native USB access,
Windows WinUSB descriptors, two full matching reads by default and local
binary/report downloads. It uses 921600 baud and targets the known 825x chip
path; it does not have the Python reader's broader backend probing. Software
checks passed, including recognition of the bench v1.4 revision. Physical
browser capture still needs validation. The browser application
and its USB descriptors are included in the public v1.5 release here.

## Hardware documentation

The [wiring diagram](wiring.svg), GPIO table and
[original programmer photos](../README.md#programmer-photos) document the
hand-wired adapter and its 1 kΩ SWS resistor.
