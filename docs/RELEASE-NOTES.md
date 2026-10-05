# Public programmer v1.5 (experimental)

The source and UF2 now combine the newer PIO speed transport and browser USB
interface with the public two-/three-byte SWS header support. Python readback
on the new transport defaults to 2 Mbaud; `--baud 1500000` selects the explicit
fallback. Older bridges retain the broad helper's 921600 default.

Includes the browser dumper with two complete matching reads by default,
Windows WinUSB descriptors for interface 4, and the guarded 256-byte-page
flash backend/sector-validation tools. Browser sessions verify three-byte
framing before opening CDC; broader Python reads preserve 825x/826x probing.
Programmer source, the rebuilt UF2, original adapter photos and the wiring
diagram are included in the repository/source archive.

The pinned source build passes without warnings. Reader/PIO, guarded-write,
browser protocol/UI and compiled USB descriptor checks passed. Prior bench
v1.4 tests found six matching 512 KiB reads at 2 Mbaud, about 29.86 seconds per
read, and two original-byte sector rewrites around 1.18 seconds. These timings
were measured on one specimen with the bench build, not the combined v1.5 UF2.
The new public UF2, physical browser capture, 826x path and full-image
installation still need physical validation. See [validation](VALIDATION.md).

This UF2 installs on the RP2040 programmer, separately from the unified
Nebular display firmware. Factory firmware dumps are not included.
