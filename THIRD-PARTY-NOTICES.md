# Third-party notices

Original project code and documentation: Gerard780, with AI-assisted
implementation and analysis, MIT license. Third-party portions retain their
notices and licenses:

| Component | Use | License / notice |
| --- | --- | --- |
| Raspberry Pi `pico-examples` | UART PIO timing adapted in `src/serial.pio` | [BSD-3-Clause](licenses/pico-examples-BSD-3-Clause.txt) |
| David Given `telinkdebugger` | Native Telink pulse decoder adaptation in `src/serial.pio` | [MIT](licenses/telinkdebugger-MIT.txt) |
| Raspberry Pi Pico SDK 2.2.0 | Firmware build dependency, incorporated in UF2 | [BSD-3-Clause](licenses/pico-sdk-BSD-3-Clause.txt) |
| TinyUSB | Firmware USB dependency, incorporated in UF2 | [MIT](licenses/tinyusb-MIT.txt) |
| pvvx `TlsrComSwireWriter` / `TLSR825xComFlasher.py` / `TLSR826xComFlasher.py` | Vendored pinned host reader/flasher, upstream author pvvx and listed contributors | [Unlicense](licenses/pvvx-Unlicense.txt) |

Pico SDK and TinyUSB sources are external build dependencies, not vendored here.
The supplied UF2 retains their distributed binary attribution through these
notices. 825x host reader commit:
`44784ba12479344bf127c5d7034bd7c5ece2524a`; SHA-256:
`2ea1b7c5266821e5d384a263daa7916bb4020fcdfb8f1ec0bed5842dcb94ca18`.

Upstream projects:
[pico-examples](https://github.com/raspberrypi/pico-examples),
[telinkdebugger](https://github.com/davidgiven/telinkdebugger),
[pico-sdk](https://github.com/raspberrypi/pico-sdk),
[TinyUSB](https://github.com/hathach/tinyusb),
[TlsrComSwireWriter](https://github.com/pvvx/TlsrComSwireWriter).

826x reader commit: `6455f50f25dd264ac6820ecacfd64b90c6c80f3e`; SHA-256:
`662ab933d8d97424c140b47a748e859d4453d14edc468c41874fb020ba93bdb0`.
