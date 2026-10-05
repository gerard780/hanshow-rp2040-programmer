# Browser tag firmware dumper — RP2040 and CH340

Capture a tag's complete main flash using an **RP2040-Zero** or a **CH340/CH341
USB UART** in desktop Chrome or Edge. RP2040 uses WebUSB plus Web Serial;
CH340 uses Web Serial alone and needs no programmer firmware. The binary and
verification report stay on your computer. For RP2040, install the
[public v1.5 UF2](../dist/hanshow_pio_bridge.uf2) using BOOTSEL.
Tag firmware does not need to be changed for either adapter.

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

## RP2040 capture

1. Connect the tag according to the [wiring guide](../README.md). Remove its
   battery when powering it from the Zero's 3V3. GP0 goes through 1 kΩ to SWS;
   GP1 connects directly to that same SWS node. GP2 goes to RST. UART is optional.
2. Select **RP2040-Zero** in the adapter menu, then choose the RP2040 USB device, then its **SWS `if00` serial interface**.
   Close other serial tools. The browser verifies USB/serial association before
   halting the CPU. On v1.5 it selects and verifies three-byte SWS addressing
   before opening serial, including after a Python 826x readback session.
3. Leave full verification enabled and click **Dump full flash**. The browser
   reads the complete detected main flash twice and compares every byte.
4. Save both the `.bin` and `.json` report. Matching complete reads are required
   for a fully verified backup. The report and activity log record cleanup errors.

The browser defaults to **2 Mbaud on v1.4/v1.5**, matching the Python reader,
and 921600 baud on v1.3. For a verification failure, reconnect and select
**1.5 Mbaud** before choosing the serial port; 921600 is also available.
The verified 24 MHz clock setting gives SWS dividers 24, 32 and 52 respectively.
The activity log and downloaded report record the actual capture baud/divider.
Use [readback.py](../readback.py) for broader legacy backend probing.
Browser capture with the combined v1.5 build still needs physical validation.
The software tests use simulated USB/serial data, not a connected tag.

## CH340/CH341 capture

Select **CH340 / CH341 UART** in the adapter menu. The page then shows CH340
wiring and a single **Choose CH340 port** button; it does not request a WebUSB
device, install a UF2 or use RP2040 vendor commands. Your operating system must
provide the adapter's serial driver so Chrome/Edge can list its port.

Use a **3.3 V logic** adapter and a 3.3 V tag supply. A board's 3.3 V supply pin
does not establish the voltage of its TX/modem signals. Remove the tag battery
when supplying power externally. Wire these connections:

| USB UART connection | Tag connection |
| --- | --- |
| TX through 1 kΩ | SWS |
| RX directly | The same SWS pad |
| GND | GND |
| 3.3 V supply | VCC |
| RTS, optional active-low output | RST |

Leave DTR unconnected. Reset pulses are **off by default** in CH340 mode; enable
them only with RTS connected to the tag's reset pad. Otherwise the tool uses
SWS soft reset/CPU-stop activation. If firmware sleeps before it can respond,
try manual reset or a longer activation time. Close other serial tools first.

The browser opens at **921600 baud** and calibrates SWS using register readback
and three matching known chip responses. The 60-byte waveform chunks wait for
their UART echoes individually, including activation traffic. Reads request and
decode nine sampled UART bytes for each flash byte, matching the existing
legacy UART/SWS path; no native PIO capture exists in the CH340 adapter.
Consequently this mode takes longer than RP2040 native block capture.

Leave full verification checked, click **Dump full flash**, and save the binary
and report after two complete reads agree. The report identifies the adapter
and its USB VID/PID. Mismatch, cancellation and cleanup handling apply to both
modes. Known UART USB IDs come from the
[Linux CH341 serial driver](https://github.com/torvalds/linux/blob/master/drivers/usb/serial/ch341.c);
this does not support a CH341 board operating as an SPI/I²C programmer.

The browser CH340 path has protocol and simulated Chromium tests. It uses the
legacy transport previously exercised with a physical CH340, but the new
browser path has not yet been validated on a physical CH340/tag combination.

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
backup download. Mismatch logs include the exact first differing address,
number of differing bytes in the block and the first four byte pairs. One
additional read of that block reports whether the disagreement is repeatable;
the failed capture remains rejected even if that diagnostic read matches.
A physically disconnected USB link can prevent cleanup; the
log reports this and the tag may need a power cycle. Select both devices again
for another attempt. The browser issues SPI reads, JEDEC identification and
wake commands only; it has no flash erase/program/unlock/status-write path.

## USB and validation

The v1.5 firmware exposes two CDC interfaces plus control-only vendor interface
4. Its Microsoft OS descriptors bind only interface 4 to WinUSB on Windows;
the serial interfaces retain normal drivers. Linux needs serial and USB
permissions for prototype VID/PID `cafe:4012`.

Run `node --test firmware-dumper/tests/readback.test.cjs firmware-dumper/tests/ch340.test.cjs` for protocol, full-read,
mismatch, cancellation, identity and address-width tests. The optional
`tests/browser-smoke.cjs` uses Playwright and simulated devices to check actual
UI downloads and cleanup. `tests/ch340-browser-smoke.cjs` checks serial-only
capture with WebUSB absent, adapter filters, downloads, wrong ports and
cancellation. `DUMPER_URL` and `CHROMIUM_PATH` configure the local
preview and browser. Compiled descriptor checks are in
`tests/test_descriptors.py`; `PROGRAMMER_BUILD_DIR` selects the firmware build.
See [validation](../docs/VALIDATION.md) for physical evidence and limits.
