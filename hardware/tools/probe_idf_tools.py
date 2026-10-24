"""Probe how idf_tools.py sees the installed tools on this machine.

Run with the ESP-IDF venv Python so its imports line up exactly with what
`idf_tools.py export` uses:

    C:\Espressif\tools\python\v6.0.2\venv\Scripts\python.exe tools\probe_idf_tools.py
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

IDF_PATH = Path(r"C:\esp\v6.0.2\esp-idf")

sys.path.insert(0, str(IDF_PATH / "tools"))

# Make idf_tools see the same environment as `export.ps1` would set.
import idf_tools  # noqa: E402

g = idf_tools.g
g.idf_path = str(IDF_PATH)
g.idf_tools_path = r"C:\Espressif\tools"
g.tools_json = str(IDF_PATH / "tools" / "tools.json")

tools = idf_tools.load_tools_info()
print(f"loaded {len(tools)} tools from {IDF_PATH / 'tools' / 'tools.json'}")
print()

for name, tool in tools.items():
    tool.find_installed_versions()
    installed = list(tool.versions_installed)
    in_path = tool.version_in_path
    host = tool.get_path()
    print(f"=== {name}")
    print(f"    install type : {tool.get_install_type()}")
    print(f"    versions     : {list(tool.versions.keys())}")
    print(f"    host path    : {host}")
    print(f"    host exists  : {os.path.exists(host)}")
    print(f"    in PATH      : {in_path}")
    print(f"    installed    : {installed}")
    root = Path(r"C:\Espressif\tools") / name
    if root.exists():
        children = [c.name for c in root.iterdir()]
        print(f"    root children: {children[:10]}")
    print()

# Now run the export to see what env vars come out
print("=== export result ===")
try:
    import argparse
    ns = argparse.Namespace()
    ns.deactivate = False
    ns.prefer_system = True
    ns.tools_json = None
    idf_tools.action_export(ns)
except SystemExit as e:
    print(f"SystemExit: {e}")
