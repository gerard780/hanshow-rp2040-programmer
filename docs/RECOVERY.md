# Recover an interrupted browser installation

## D10 interrupted-install recovery — 2026-10-20.1

The [D10 recovery page](https://gerard780.github.io/hanshow-rp2040-programmer/support/recovery-437-d10-20261020/)
reads the failed installer's report and saved full backup on your computer.
Select both files in step 1. The report can be the downloaded JSON file or a
text file containing the complete JSON report; an activity log alone does not
include the required identity and backup checks. The report must identify an
unverified installation that left the CPU halted. Backup SHA-256 and flash UID
must match that report before restoration. Neither file is uploaded, and no
incident-specific identity or backup hashes are embedded in the public page.
The USB/SWS association and programmer v1.6 checks still apply.

Keep the tag powered. Disconnect only GP2 from tag RST, leave power, ground and
both SWS connections in place, and close other programmer connections. Select
the report and saved full backup, confirm the reset wire is disconnected, connect the
programmer and choose its SWS port. Click **Check my tag**, then **Restore saved
backup** after the check passes. Keep the page open throughout both operations.

This page restores only the pre-install backup. It uses 460800 baud, 64-byte
programs and native SPI status reads. Both check and restore require two fresh
matching full reads, the correct tag identity and unchanged factory data above
the application. Restore rechecks before writing and allows three checked
attempts per sector. A retry requires a paused tag, matching UID/protection,
two matching sector reads and no new transport faults; already correct data is
accepted without another erase. New faults are not cleared or ignored.

The final restart requires full 512 KiB equality and exact saved protection.
On failure, keep power on, leave the tag paused and save the recovery report.
Do not run the normal D10 installer on the interrupted image. The pre-install
backup is not assumed to be factory firmware. Browser tests use simulated
devices; physical recovery remains unverified. The older support page below
retains its separate incident binding and settings.

## Temporary browser recovery page

If Gerard sent you a temporary recovery link, use that page. It is set up for the
failed-install report and checks the original backup, programmer and tag. No
Python, commands, report-file picker or speed settings are needed.

1. Select the complete original backup `.bin` from before the failed installation.
2. Choose included D9, another application `.bin`, or original firmware only.
3. Disconnect GP2 from tag RST, keep the other wires and power connected, and use
   the two connection buttons on the page.
4. Click **Check my tag**, then the green recovery button after the check passes.

The page restores and verifies the original image before installing a chosen
application. It keeps the CPU halted through both stages and restarts only after
the final image and protection settings verify. Recovery uses conservative
64-byte programs at 921600 baud automatically. Keep the page and power connected
until completion; if it stops, save its report and send it to Gerard.

The included D9 is pinned to the source gist revision recorded in the page's
firmware metadata. Customer backup bytes and full reports are not hosted. Device
matching uses hashed identifiers. Temporary support URLs are public GitHub Pages
links with indexing disabled; they are not an access-controlled service.
Software/browser simulations passed. Physical use of this recovery flow remains
unverified. RP2040 v1.6 remains sufficient.

<details>
<summary>Optional Python recovery for advanced users</summary>

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

</details>
