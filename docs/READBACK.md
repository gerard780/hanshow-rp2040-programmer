# Factory readback and support requests

Read the factory firmware **before installing experimental firmware or changing
tag settings**. A dump from a tag already running a replacement application
is useful for recovery but is not an original factory-firmware capture.
Keep a complete same-tag backup even if you send a copy for research.

## Hardware scope

The known bench tags returned chip bytes `02 62 55`, JEDEC ID `EB 60 13` and
512 KiB flash. The new reader does **not** require those exact IDs. It tries
825x-style three-byte SWS addressing, then 826x-style two-byte SWS addressing,
using the legacy flash/SPI register map. Both paths must pass repeated chip and
JEDEC reads and two identical nonblank sample reads before capture.

This is a compatibility probe, not proof that every Telink MCU is supported.
Modern families using different debug/register/flash controllers need a new
backend. Conventional JEDEC capacity bytes provide auto-size; reads use
three-byte SPI addresses and are limited to **16 MiB**. A larger device cannot
be captured completely by this backend. A nonstandard capacity code requires
an explicit `--size` based on identified flash hardware; it is not labeled a
verified complete dump unless the full capacity is independently detected.

Public programmer v1.3 supports both SWS address widths. The old bench v1.1/1.2
firmware supports only the 825x-style width and refuses the 826x selection.
The firmware and reader are supplied as an experimental release; the broader
chip paths need physical evidence.

The programmer source supports the bridge transport; that does not establish
compatibility with every Hanshow model. The [wiring diagram](wiring.svg) uses
signal names, because tag pad placement must be identified on each PCB.

## Setup and port identification

From the repository root:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m serial.tools.list_ports -v
```

Select the Zero's **SWS `if00` interface**, not its UART `if02` interface.
On Linux, use its stable path under `/dev/serial/by-id/`. The serial-port listing
shows the board's serial ID; supply that exact value as `--bridge-serial`.
USB VID/PID is prototype `cafe:4012`. Close other applications using either
programmer/SWS port before starting. Serial and PyUSB access are required; the
tested Linux setup uses `sudo` with the virtual environment's Python.

Connect the tag with USB unplugged. Disconnect its battery before supplying
VCC from the Zero's 3V3. Check the resistor and direct sense connection against
the diagram, then reconnect USB. UART is not required.

## Read twice and verify

```sh
sudo .venv/bin/python readback.py \
  --port /dev/serial/by-id/YOUR_ZERO_SWS_INTERFACE_if00 \
  --bridge-serial YOUR_ZERO_SERIAL --family auto --mode block \
  --runs 2 --output factory-backup
```

The helper refuses an existing output directory. A successful run creates:

- `factory-backup/flash-1.bin` and `flash-2.bin`, each the detected flash size.
- `factory-backup/readback.json`, recording both SHA-256 values, chip/flash
  IDs, backend attempts, transport fault counts, reset checks, `verified: true`
  and `complete_flash: true` for a full auto-sized capture.

Both dumps must match and the helper must exit successfully. `verified: false`,
an error, a short file, an all-zero/all-FF capture or a mismatch is not a usable
factory backup. Preserve failed logs for diagnosing the reader, but label them
as failed. After successful reading, the helper attempts CPU reset and confirms
reset release. If interrupted or left halted, disconnect the programmer before
returning the tag to its normal power supply.

For a short transport check, change `--size` to `4096` and use another output
directory. That verifies a sample; it is **not** a complete factory dump.
Use `--family 825x` or `--family 826x` to select a framing backend explicitly.
Use `--clock-mhz 16`, `24`, `32` or `48` to constrain the divider probe; the
chosen value is a divider setting, not a measured chip-clock frequency. Linux
was the tested host; other OSes may need USB backend/driver configuration.

## Send evidence for another Hanshow tag

Contact **[Gerard780](https://github.com/gerard780)** through a
[support request](https://github.com/gerard780/nebular-pro-qn-atc-oepl/issues/new?title=Hanshow%20tag%20support%20request)
to arrange sending the factory dump. Include:

- Exact model, size, color capability and case/hardware revision.
- Clear front/back, PCB, MCU/flash markings and display flex-cable photographs.
- Which pad is which, how the readback was taken and the detected chip/flash IDs.
- One complete verified factory `.bin`, its SHA-256, and the two-read verification
  result. Keep both matching reads locally; one copy is sufficient to send.

A ZIP can group the dump, verification JSON and photographs. Flash dumps can
contain per-device identities and settings; use the issue to coordinate the
transfer if you prefer not to attach those publicly. A factory dump helps
recover the panel configuration and waveforms; it does not guarantee support
without a physical specimen or additional captures.
