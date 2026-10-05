# Browser tag firmware dumper

Capture a tag's complete main flash through the RP2040-Zero using WebUSB and
Web Serial in desktop Chrome or Edge. The binary and verification report stay
on your computer. Install the [public v1.5 UF2](../dist/hanshow_pio_bridge.uf2)
on the programmer using BOOTSEL; tag firmware does not need to be changed.

**[Open the hosted dumper](https://gerard780.github.io/hanshow-rp2040-programmer/)**

`index.html` is a standalone file containing the styles, transport/UI JavaScript
and current programmer UF2 download. Copy **just that HTML file** to any static
HTTPS host; no companion assets, CDN, build service or application backend are
needed. GitHub Pages serves the identical file from `docs/index.html`.
The documentation links lead to GitHub only when you click them. Capture and
verification stay in your browser, and the UF2 download is embedded locally.

[Download the single HTML file](https://github.com/gerard780/hanshow-rp2040-programmer/releases/download/v1.5/hanshow-firmware-dumper.html).
The embedded distribution notices travel with the file when you host a copy.

From the repository root, run:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://localhost:8080/firmware-dumper/>. HTTPS hosting also works.
Keep the page open and the computer awake during capture and cleanup.

## Rebuild the standalone file

Edit `index.template.html`, `sws.js` or `app.js`, then run from the repo root:

```sh
python3 firmware-dumper/build_standalone.py
python3 firmware-dumper/build_standalone.py --check
```

The builder verifies the UF2 against its manifest and produces identical
`firmware-dumper/index.html` and `docs/index.html`. GitHub Pages uses main's
`/docs` directory; `.nojekyll` keeps the published HTML as generated.

## Capture

1. Connect the tag according to the [wiring guide](../README.md). Remove its
   battery when powering it from the Zero's 3V3. GP0 goes through 1 kΩ to SWS;
   GP1 connects directly to that same SWS node. GP2 goes to RST. UART is optional.
2. Choose the RP2040 USB device, then its **SWS `if00` serial interface**.
   Close other serial tools. The browser verifies USB/serial association before
   halting the CPU. On v1.5 it selects and verifies three-byte SWS addressing
   before opening serial, including after a Python 826x readback session.
3. Leave full verification enabled and click **Dump full flash**. The browser
   reads the complete detected main flash twice and compares every byte.
4. Save both the `.bin` and `.json` report. Matching complete reads and successful
   cleanup are required before the complete-backup downloads become available.

The browser uses **921600 baud**. Use [readback.py](../readback.py) for the
2 Mbaud default, 1.5 Mbaud fallback and broader legacy backend probing.
Browser capture with the combined v1.5 build still needs physical validation.
The software tests use simulated USB/serial data, not a connected tag.

## Scope and verification

This browser reader targets TLSR825x chip ID `0x5562`, including the known
`026255` / `eb6013` Nebular path. It recognizes these JEDEC capacities:

| JEDEC ID | Main flash bytes |
| --- | ---: |
| `eb6013`, `c86013`, `856013`, `5e3213`, `514013` | 524288 |
| `c86014`, `5e3214` | 1048576 |
| `c86010` | 65536 |

These mappings follow the Telink SDK's 8258 flash type definitions; only the
known `eb6013` path has prior physical bench evidence here. Unknown chip/flash
IDs stop capture. Separate OTP/security registers, panel-internal memory and
NFC storage are excluded. This is not browser BLE readback or an AP dumper.

Full verification is enabled by default. Disabling it instead samples 256
bytes at zero, each 64 KiB boundary and the end; the report explicitly labels
sample verification. All-00/all-FF images receive a visible warning. SHA-256
identifies captured bytes; it does not establish original OEM provenance.

Cancel stops at a bounded USB request, cancels native capture, releases SPI/FIFO,
attempts CPU reset and releases GP2. Failed/cancelled captures produce no full
backup download. A physically disconnected USB link can prevent cleanup; the
log reports this and the tag may need a power cycle. Select both devices again
for another attempt. The browser issues SPI reads, JEDEC identification and
wake commands only; it has no flash erase/program/unlock/status-write path.

## USB and validation

The v1.5 firmware exposes two CDC interfaces plus control-only vendor interface
4. Its Microsoft OS descriptors bind only interface 4 to WinUSB on Windows;
the serial interfaces retain normal drivers. Linux needs serial and USB
permissions for prototype VID/PID `cafe:4012`.

Run `node --test firmware-dumper/tests/readback.test.cjs` for protocol, full-read,
mismatch, cancellation, identity and address-width tests. The optional
`tests/browser-smoke.cjs` uses Playwright and simulated devices to check actual
UI downloads and cleanup; `DUMPER_URL` and `CHROMIUM_PATH` configure its local
preview and browser. Compiled descriptor checks are in
`tests/test_descriptors.py`; `PROGRAMMER_BUILD_DIR` selects the firmware build.
See [validation](../docs/VALIDATION.md) for physical evidence and limits.
