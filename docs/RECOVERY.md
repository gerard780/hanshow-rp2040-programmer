# Recover an interrupted browser installation

Use `recover_application.py` when an application installation fails, recovery
does not verify, and the browser reports that the CPU was kept halted. This
command restores the original application from the complete pre-install backup.
It supports RP2040 v1.6, chip `026255`, `EB6013` flash and the 128 KiB application
region. It is experimental: the new command has software transaction tests;
its conservative write backend has prior sector-rewrite bench evidence. Physical
use of this complete recovery command remains untested.

## Preserve the recovery source first

Keep the failed browser page open and the tag powered. Download its emergency
recovery backup and flashing report. The backup must be the original complete
512 KiB snapshot; its SHA-256 must match `backupSha256` in the failed report.
An application `.bin` or a dump captured after failure is not this backup.
The command checks the backup hash before accessing hardware.

Do not retry a normal application installation to restore the original image.
Once the original files are saved, close the browser's programmer connections
and other serial tools. Disconnect **GP2 from the tag's RST pad** before opening
the recovery serial port; leave power, ground and both SWS wires connected.
Serial drivers can toggle reset lines on open. The recovery command does not
pulse reset or invoke the vendor activation routine; it halts the CPU directly.
Reconnect GP2 after verified recovery.

Install this repository's `requirements.txt` in a Python environment, as for the
existing Python reader/installer. Use the RP2040's SWS port (`if00`), not Tag UART
(`if02`), and its USB serial number. On Windows, the port is its SWS `COM` port.

```sh
# Read-only check. The tag remains halted; no flash/protection writes occur.
python recover_application.py --backup original-full.bin --report failed-flash.json \
  --port YOUR_SWS_PORT --bridge-serial YOUR_RP2040_SERIAL \
  --output private/recovery-check --reset-wire-disconnected

# Restore after the read-only check passes. Use a new output directory.
python recover_application.py --backup original-full.bin --report failed-flash.json \
  --port YOUR_SWS_PORT --bridge-serial YOUR_RP2040_SERIAL \
  --output private/recovery-apply --reset-wire-disconnected --apply
```

On Linux, USB access permissions may require running these commands using the
virtual environment's Python with `sudo`. Capture directories and backups
contain per-tag data; keep them private.

## Recovery checks

The command runs at 921600 baud. Before allowing writes it verifies the report's
backup hash, RP2040/SWS association, halted CPU, repeated flash UID matching the
failed report, two matching current full reads, and unchanged bytes at/above
`0x20000`. It rejects altered factory, identity or calibration data rather than
overwriting those regions.

It restores only changed application sectors, with sector zero last, using
64-byte programs and legacy status polling. Each erase is blank-checked, each
sector verified, and the entire 512 KiB flash must match the original backup.
The exact original protection value from the failed report must verify before
the CPU reset command. A failed recovery keeps the CPU halted and records the
error in `recovery-report.json`; retain the original backup and capture directory.
