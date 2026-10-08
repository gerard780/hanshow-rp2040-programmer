# Programmer transport and USB protocol


Core 0 services two TinyUSB CDC ports. Core 1 drives PIO SWS and hardware UART1.
Each transport queue has one producer and consumer, with memory barriers.
Outgoing SWS headers select native pulse decoding for single-byte read requests;
the result is translated into the legacy reader's nine sample bytes. The
consumer peeks once before consuming so a newly arriving trigger cannot bypass
classification. Host output buffering is bounded because USB serial flush does
not guarantee the physical wire has drained.

PIO1/DMA retains an 8 MHz SWS trace for diagnostics (the first request of the
latest block, or the latest legacy request). Vendor request 1 returns bridge
status, 2 returns the 1024-byte trace, and 3 returns frame history.
The `sws_dropped_bytes` counter also counts unanswered native read requests.
The USB VID/PID `cafe:4012` is a prototype identifier.

Version 1.1's vendor control requests use these fields:

| Request | Direction | Parameters/result |
| --- | --- | --- |
| `0x10` | OUT (`0x40`) | Start capture; `wValue` = byte count 1..4096, `wIndex` = 0, no payload |
| `0x11` | IN (`0xc0`) | Eight-byte status: little-endian uint32 state and completed count |
| `0x12` | OUT (`0x40`) | Cancel capture; no payload |
| `0x13` | IN (`0xc0`) | Read captured bytes; `wValue` = buffer offset, `wIndex` = 0, `wLength` = size |

States are 0 idle, 1 busy, 2 done, 3 error/cancelled. Start requires an already
sent and echoed SWS read header; completion does not send the SWS stop command.
The host sends stop afterward and closes the SPI transaction when reading flash.
Concurrent starts and out-of-range counts are rejected. Payload is available
only in a terminal state; status and data transfers are separate to keep each
USB control transfer within Linux's 4096-byte limit. Memory barriers publish
the captured data across cores. The UART port remains serviced during capture.


Public version 1.3 adds request `0x21` to select the SWS address width while
CDC0 is closed: OUT (`0x40`), `wValue` 2 or 3, `wIndex` 0, zero data length.
IN (`0xc0`), `wValue`/`wIndex` 0, length 4 returns the width as LE uint32.
The host sets 3 for the 825x-style backend or 2 for the 826x-style backend,
then checks readback before opening SWS. Width changes are rejected while SWS
or block capture is active. Default width is 3. This changes header recognition;
the PIO pulse decoder and flash transfer protocol remain the same.

## Public v1.5 integration

Status revision is `0x00010005`, USB device revision `0x0105`. The two-byte
address selection from public v1.3 is retained. The longer native reply PIO
runs on PIO1 beside the tracer, consumes the end pulse and waits using its
measured low duration before publishing. Block captures restart parked state
machines rather than reinitializing them for every byte; the request pulse
scales to two UART bit times at the configured baud.

USB interface 4 is control-only vendor class. USB 2.1 BOS and Microsoft OS
2.0 descriptors bind this interface to WinUSB on Windows while keeping the
two CDC interfaces on their normal drivers. Request `0x30`, IN `0xc0`,
`wIndex` 7, `wValue` 0 returns the OS descriptor. The browser selects and
verifies three-byte SWS addressing before opening CDC. The browser and Python tools default to 2 Mbaud on v1.4–v1.6;
older browser v1.3 sessions use 921600 baud.

## Public v1.6 reconnect correction

Status revision is `0x00010006`, USB device revision `0x0106`. For request
`0x21`, OUT selecting the current width now acknowledges without changing
state, including during an active SWS/capture session. Invalid widths still
stall; a genuine change between 2 and 3 still stalls while SWS, capture or
queued transmit data is active. This fixes repeated host connections after
legacy activation retained SWS across DTR changes. Hosts read the current
width first for compatibility with v1.5. After using two-byte framing, USB
reconnection may be needed before switching families. PIO timing, USB
interface numbers and the block-capture protocol are unchanged.
