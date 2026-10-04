# Public programmer v1.3 (experimental)

RP2040-Zero firmware, source and wiring for a Telink SWS bridge with a separate
tag UART. Native USB block reads capture up to 4096 bytes per request. This
build enables GP2 tag reset and adds selectable two- and three-byte SWS
address framing.

The readback helper probes legacy 825x/826x-style backends without an exact
chip-ID or flash-manufacturer allowlist, detects conventional JEDEC capacity,
and requires matching samples and repeated captures. It records whether a
capture covers the complete detected flash and checks reset release.

The source build and seven host tests passed. The new reader passed matching
4 KiB reads on a known Nebular 154 using the earlier bench bridge v1.2.
Public v1.3 firmware and the 826x framing path still need physical validation;
other Telink register maps require additional backends. See
[validation](VALIDATION.md) for the evidence and limits.

This UF2 installs on the RP2040 programmer. It is separate from the unified
Nebular display firmware. No factory firmware dumps are included.
