# Browser tag firmware backup and flashing

Capture a tag's complete main flash or install a prepared application through the RP2040-Zero using WebUSB and
Web Serial in desktop Chrome or Edge. The binary and verification report stay
on your computer. Install the [public v1.6 UF2](../dist/hanshow_pio_bridge.uf2)
on the programmer using BOOTSEL; tag firmware does not need to be changed.

**[Dumper only](https://gerard780.github.io/hanshow-rp2040-programmer/)** ·
**[Read/write/discovery tools](https://gerard780.github.io/hanshow-rp2040-programmer/tools/)**

`index.html` is a standalone file containing the styles, transport/UI JavaScript
and current programmer UF2 download. Copy **just that HTML file** to any static
HTTPS host; no companion assets, CDN, build service or application backend are
needed. GitHub Pages serves the full tool from `docs/tools/index.html`.
The root `docs/index.html` is a separate dumper-only bundle with no flashing
or discovery scripts/controls. Both pages are standalone HTML files.
The documentation links lead to GitHub only when you click them. Capture and
verification stay in your browser, and the UF2 download is embedded locally.

[Download the single HTML file](https://github.com/gerard780/hanshow-rp2040-programmer/releases/download/web-2026.10.13.2/hanshow-firmware-tool.html).
The embedded distribution notices travel with the file when you host a copy.

From the repository root, run:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://localhost:8080/firmware-dumper/>. HTTPS hosting also works.
Keep the page open and the computer awake during capture and cleanup.

## Rebuild the standalone file

Edit `index.template.html`, `sws.js`, `flash.js`, `discovery.js`, `discovery-ui.js` or `app.js`, then run from the repo root:

```sh
python3 firmware-dumper/build_standalone.py
python3 firmware-dumper/build_standalone.py --check
```

The builder verifies the UF2 against its manifest and generates both:

- Full tools: `firmware-dumper/index.html` and `docs/tools/index.html`.
- Dumper-only: `firmware-dumper/read-only.html` and `docs/index.html`.

Each pair is byte-identical. GitHub Pages uses main's
`/docs` directory; `.nojekyll` keeps the published HTML as generated.

## Capture

1. Connect the tag according to the [wiring guide](../README.md). Remove its
   battery when powering it from the Zero's 3V3. GP0 goes through 1 kΩ to SWS;
   GP1 connects directly to that same SWS node. GP2 goes to RST. UART is optional.
2. Choose the RP2040 USB device, then its **SWS `if00` serial interface**.
   Close other serial tools. The browser verifies USB/serial association before
   halting the CPU. On v1.5/v1.6 it selects and verifies three-byte SWS addressing
   before opening serial, including after a Python 826x readback session.
3. Leave full verification enabled and click **Dump full flash**. The browser
   reads the complete detected main flash twice and compares every byte.
4. Save both the `.bin` and `.json` report. Matching complete reads and successful
   cleanup are required before the complete-backup downloads become available.

The browser defaults to **2 Mbaud on v1.4/v1.5/v1.6**, matching the Python reader,
and 921600 baud on v1.3. For a verification failure, reconnect and select
**1.5 Mbaud** before choosing the serial port; 921600 is also available.
The verified 24 MHz clock setting gives SWS dividers 24, 32 and 52 respectively.
The activity log and downloaded report record the actual capture baud/divider.
Use [readback.py](../readback.py) for broader legacy backend probing.
Browser capture with the v1.6 build still needs physical validation.
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
backup download. Mismatch logs include the exact first differing address,
number of differing bytes in the block and the first four byte pairs. One
additional read of that block reports whether the disagreement is repeatable;
the failed capture remains rejected even if that diagnostic read matches.
A physically disconnected USB link can prevent cleanup; the
log reports this and the tag may need a power cycle. Select both devices again
for another attempt. The backup operation issues SPI reads, JEDEC identification and
wake commands only. The separate application installation operation below
can unlock, erase and program the application region.

## Browser application flashing (revision 2026-10-13.2)

Give the recipient **one application `.bin`** and the [tools page](https://gerard780.github.io/hanshow-rp2040-programmer/tools/).
No JSON, expected-flash image, recovery file, Python preparation or application
backend is needed. The page accepts the raw KNLT/CRC application binary or its
4 KiB FF-padded form, up to 128 KiB. Full 512 KiB tag dumps and programmer UF2
files are rejected. The published unified 1.54/2.66 application passes this
format check; format validation does not establish display/board compatibility.
Choose firmware intended for the connected tag.

The programmer must run existing **v1.6**; no RP2040 firmware update is needed
on v1.6. Use desktop Chrome/Edge with HTTPS or localhost. Writing remains
restricted to `026255` / `EB6013` with known protection status. Broader Python
readback compatibility does not imply broader write support.

1. Select the single application `.bin`, connect the programmer and its SWS port.
2. Leave **Save a full recovery backup before flashing** checked to save a
   verified full recovery `.bin` to the file you choose. Uncheck it to skip
   the file-save dialog and disk backup.
3. Choose **Check firmware** for a dry run, or acknowledge that the application
   is intended for this tag and choose **Flash application**.
4. Keep the browser and tag powered through verification/recovery, and save
   the operation report.

The tool still takes two matching full reads with saving disabled. These reads
build the expected image from this tag's own contents, preserve all bytes above
the padded application, and retain original bytes for in-session recovery.
This option skips the saved backup file, not preservation reads or verification.
When saving is enabled, closing/rereading the recovery file must verify before
unlock. File-save API access is needed only when saving is enabled.

The plan is built locally in the browser. Application header/length/CRC and FF
padding are checked before hardware access. Changed application sectors below
`0x20000` are written with sector zero last, each erase is blank-checked, pages
and the complete 512 KiB expected image are verified, and exact protection is
restored before CPU reset. There is no mass erase or upper-flash programming.
A checksum cannot establish that an image is suitable for a particular display.

Cancellation completes the current sector and attempts original-byte recovery
from memory using 64-byte programs and legacy status reads at the selected baud.
If recovery/protection cannot verify, the CPU stays halted. When no file was
saved, an emergency original-backup download is offered after such a failure.
Download it while the page is still open. Closing/reloading the page or losing
power before recovery can lose the in-memory original; a saved backup is
recommended. With a saved file, retain it and the report for recovery.

Protocol/flash-state and Chromium UI tests cover both saving and skipping,
malformed binaries, factory preservation and failure/cancellation recovery.
Physical browser writes, Windows hardware and full 437 installation/display
behavior remain untested. Prior Python v1.6 write evidence is separate.
See [validation](../docs/VALIDATION.md) and [flashing](../docs/FLASHING.md).

## Discovery progress and logs

Use [/tools/](https://gerard780.github.io/hanshow-rp2040-programmer/tools/) with
a tag running our 437 D8/D9 discovery firmware. Three independent readers are
available; none starts, pauses, selects or confirms a display trial.

- **Bluetooth status:** Connect discovery tag, then read status or keep the
  5-second polling enabled. The only request is discovery operation0 (STATUS)
  on service/characteristic `00001337-0000-1000-8000-00805f9b34fb`. Protocol
  v1/v2 notifications report profile, attempt, stage/panel state, temperature,
  next/wait state, confirmation and the D9 journal-health flag. Timeouts close
  the connection so late replies cannot be treated as a later response.
- **Live UART:** Choose the RP2040 second port, Tag UART/GPIO4/5 (`if02`), at
  the firmware's baud. Connect GP5 to tag TX and common GND. The listener sends
  no serial commands or reset pulse and can remain connected during flashing
  to record boot/progress output. The actual D8/D9 `N437` lines are decoded;
  other text is retained. Select the SWS port only for readback/flashing.
- **Stored D9 journal:** Load a 512 KiB backup or the 4 KiB sector at `0x1f000`.
  Full readback on the tools page also attempts journal decoding. Header and
  every record CRC are checked; torn/invalid slots are reported, not treated
  as valid events. Session, attempt, profile, uptime, panel/pass, temperature
  and fault flags are displayed. This offline decoder never modifies a file.

Save discovery session exports the bounded live event history and loaded
journal as local JSON. BLE/UART status can be read without halting the tag;
SWS full readback deliberately pauses/resets it and may restart trials.
Electrical completion is distinct from visual image success. The supplied
firmware controller handles visual confirmation; this tools page is a reader.

For a raw D9 application carrying its exact CRC-covered journal descriptor,
the single-bin planner reserves/initializes the documented journal sector and
preserves existing valid-header journal bytes on reflash. Ordinary firmware
does not trigger this behavior. Captured per-tag journal records are rejected
as distributable application-file input. The application CRC excludes mutable
journal records; full verification happens while the CPU remains halted, before
boot can append new events. Upper flash at/above `0x20000` remains preserved.

Discovery UART/Bluetooth hardware and physical browser writes remain untested;
protocol and Chromium UI checks use simulated devices. No RP2040 update beyond
existing v1.6 is needed. Web Bluetooth availability depends on browser/platform;
UART and offline journal decoding remain available when Bluetooth is absent.

## USB and validation

The v1.6 firmware exposes two CDC interfaces plus control-only vendor interface
4. Its Microsoft OS descriptors bind only interface 4 to WinUSB on Windows;
the serial interfaces retain normal drivers. Linux needs serial and USB
permissions for prototype VID/PID `cafe:4012`.

Run `node --test firmware-dumper/tests/readback.test.cjs firmware-dumper/tests/flashing.test.cjs firmware-dumper/tests/single-bin.test.cjs firmware-dumper/tests/discovery.test.cjs firmware-dumper/tests/transport-recovery.test.cjs` for protocol, full-read,
mismatch, cancellation, identity and address-width tests. The optional
`tests/browser-smoke.cjs` uses Playwright and simulated devices to check actual
UI downloads and cleanup; `DUMPER_URL` and `CHROMIUM_PATH` configure its local
preview and browser. Compiled descriptor checks are in
`tests/test_descriptors.py`; `PROGRAMMER_BUILD_DIR` selects the firmware build.
See [validation](../docs/VALIDATION.md) for physical evidence and limits.

## Interrupted browser write recovery (2026-10-13.3)

Use 1.5 Mbaud or 921600 baud for browser writes; select it before opening the serial
port. 2 Mbaud remains available for readback/checks. Each 60-byte encoded chunk is
acknowledged before the next, and recovery drains stale bytes and verifies the
CPU halt and target UID before restoration. Reports include attempted sectors,
recovery sector events and sector mismatch address/hashes.

When recovery fails, keep the page and tag powered, save the original emergency
backup and report, and follow [original-backup recovery](../docs/RECOVERY.md).
The recovery command uses 921600 baud and 64-byte programs, never overwrites factory
data, and requires full-image equality and restored protection before CPU reset.
Software simulation is the validation for these changes; successful physical
browser installation/recovery remains unverified. The RP2040 v1.6 UF2 is unchanged.

## Temporary browser recovery page (2026-10-13.4)

`support/template.html`, `support/config.js`, `support/firmware.js` and
`support/app.js` build a separate personal support page. It includes pinned D9,
a supplied-application option and original-only restoration; the user selects
one original backup, uses fixed recovery timing and never invokes Python or
selects a report file. The support configuration stores hashes for matching
the reported backup/programmer/tag; raw identifiers and backup bytes are not
published. Its GitHub Pages URL is public, temporary and excluded from indexing.

`recovery.js` restores the original 128 KiB region after matching complete current
reads, rejects changed factory data, verifies all 512 KiB against the original
backup and restores exact original protection. Optional new-app installation
keeps the CPU halted across both stages. Successful restart occurs after final
image/protection verification. Opening a serial port can toggle reset, so the
user must disconnect GP2 from RST before connecting. Both stages use 921600 baud
and conservative 64-byte programs. The existing RP2040 v1.6 UF2 is unchanged.

Run `node --test firmware-dumper/tests/recovery.test.cjs` for recovery transaction
checks and `tests/recovery-smoke.cjs` with Playwright for the support-page flows.
Successful physical recovery remains unverified. See [recovery](../docs/RECOVERY.md).
