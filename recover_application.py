#!/usr/bin/env python3
"""Recover an interrupted browser installation using its original full backup."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent / "tools/speed"))
from application_recover import main

if __name__ == "__main__":
    raise SystemExit(main())
