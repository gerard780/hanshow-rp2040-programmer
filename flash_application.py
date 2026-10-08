#!/usr/bin/env python3
"""Command-line entry point for the guarded application installer."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent / "tools/speed"))
from application_install import main

if __name__ == "__main__":
    raise SystemExit(main())
