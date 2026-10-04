#!/usr/bin/env python3
"""Wrap the SDK's flat RP2040 flash binary in the standard UF2 container."""
import argparse
import struct
from pathlib import Path


def convert(source: Path, output: Path) -> None:
    data = source.read_bytes()
    if not 256 <= len(data) <= 2 * 1024 * 1024:
        raise ValueError("Expected an RP2040 flash image between 256 bytes and 2 MiB")
    blocks = (len(data) + 255) // 256
    with output.open("wb") as stream:
        for index in range(blocks):
            payload = data[index * 256:(index + 1) * 256].ljust(256, b"\x00")
            header = struct.pack("<8I", 0x0A324655, 0x9E5D5157, 0x2000,
                                 0x10000000 + index * 256, 256, index,
                                 blocks, 0xE48BFF56)
            stream.write(header + payload + bytes(220) + struct.pack("<I", 0x0AB16F30))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    convert(args.source, args.output)
