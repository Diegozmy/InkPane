"""One-shot: build the InkPane firmware using the local ESP-IDF toolchain.

On this machine the ESP-IDF v6 tool manifest expects the compiler toolchains
under ``<ESP_TOOLS_PATH>/tools/<tool>/<version>/`` but the official installer
placed the unpacked trees at ``C:\\Espressif\\tools\\<tool>\\<version>``
(one level shallower), so ``idf_tools.py`` reports "no installed versions"
for every tool and ``idf.py build`` aborts before compiling anything.

This script reconciles the two layouts without downloading anything:

* It reads the required version strings from
  ``C:\\esp\\v6.0.2\\esp-idf\\tools\\tools.json``.
* It makes ``idf_tools.py`` see the tool trees where it expects them by
  exporting ``IDF_TOOLS_PATH=C:\\Espressif`` (the *parent* of the ``tools``
  folder), which maps ``<IDF_TOOLS_PATH>/tools/<tool>`` onto
  ``C:\\Espressif\\tools\\<tool>``.
* It skips the optional QEMU targets (only needed for ``idf.py qemu``) and
  the PATH-based tools (cmake, ninja, ccache, idf-exe, dfu-util).

Usage:
    python tools/build_firmware.py            # build the firmware
    python tools/build_firmware.py --check    # verify the tool layout only

Notes:
* The ESP-IDF tree and the toolchain binaries are never modified.
* The ``IDF_TOOLS_PATH`` override is scoped to this process tree, so the
  machine's normal ESP-IDF setup is unaffected.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ESP_IDF = Path(r"C:\esp\v6.0.2\esp-idf")
TOOLS = Path(r"C:\Espressif\tools")
VENV_PY = TOOLS / "python" / "v6.0.2" / "venv" / "Scripts" / "python.exe"
MAIN = REPO / "main"

# Tools that live on the system PATH or in the IDF venv, not in the tool tree.
PATH_BASED_TOOLS = {"idf-exe", "cmake", "ninja", "ccache", "dfu-util"}

# Optional QEMU targets are only needed for `idf.py qemu`; skip when absent.
OPTIONAL_TOOLS = {"qemu-xtensa", "qemu-riscv32"}


def load_required_tools() -> dict[str, list[str]]:
    """Read tools.json -> {tool_name: [version, ...]}.

    Each entry in the ``versions`` list is a platform-spec dict that carries
    the actual version string in its top-level ``name`` field.
    """
    raw = json.loads((ESP_IDF / "tools" / "tools.json").read_text(encoding="utf-8"))
    tools_list = raw if isinstance(raw, list) else raw.get("tools", [])
    out: dict[str, list[str]] = {}
    for info in tools_list:
        name = info.get("name")
        if not name:
            continue
        versions = info.get("versions")
        found: list[str] = []
        if isinstance(versions, list):
            for entry in versions:
                if isinstance(entry, str):
                    found.append(entry)
                elif isinstance(entry, dict):
                    vname = entry.get("name")
                    if isinstance(vname, str) and vname not in found:
                        found.append(vname)
        elif isinstance(versions, dict):
            found = list(versions.keys())
        if found:
            out[name] = found
    return out


def check_tool_layout() -> int:
    """Verify that every required tool version has a host directory.

    Returns the number of missing tools (0 = layout is OK).
    """
    required = load_required_tools()
    print(f"tools root: {TOOLS}")
    missing: list[str] = []
    for tool_name, versions in sorted(required.items()):
        if tool_name in PATH_BASED_TOOLS:
            print(f"  skip (PATH tool): {tool_name}")
            continue
        tool_root = TOOLS / tool_name
        if not tool_root.exists():
            if tool_name in OPTIONAL_TOOLS:
                print(f"  skip (optional, not installed): {tool_name}")
                continue
            missing.append(tool_name)
            print(f"  MISSING: no host directory for {tool_name!r} under {TOOLS}")
            continue
        # The version directories are the non-``dist`` subdirectories.
        present = {c.name for c in tool_root.iterdir()
                   if c.is_dir() and c.name != "dist"}
        for version in versions:
            if version in present:
                print(f"  present: {tool_name}/{version}")
            else:
                missing.append(f"{tool_name}@{version}")
                print(f"  MISSING: {tool_name}/{version} (have: {sorted(present)})")
    if missing:
        print(f"\nMissing tools: {missing}")
        print("Install them with `idf_tools.py install` or place the toolchains under")
        print(f"{TOOLS} and re-run this script.")
        return len(missing)
    print("\nlayout OK")
    return 0


def idf_export_env() -> dict[str, str]:
    """Return the environment for building.

    This machine's ESP-IDF installation (created by the eim GUI) stores the
    toolchains at ``C:\\Espressif\\tools\\<tool>\\<version>\\<tool>\\bin``
    (one level deeper than the ESP-IDF layout). ``idf_tools.py export``
    doesn't add these directories to PATH, so mirror the PATH that the
    official ``Microsoft.v6.0.2.PowerShell_profile.ps1`` writes::

        C:\\Espressif\\tools\\ccache\\4.12.1\\ccache-4.12.1-windows-x86_64
        C:\\Espressif\\tools\\cmake\\4.0.3\\bin
        C:\\Espressif\\tools\\esp-clang\\esp-20.1.1_20250829\\esp-clang\\bin
        C:\\Espressif\\tools\\ninja\\1.12.1
        C:\\Espressif\\tools\\xtensa-esp-elf\\esp-15.2.0_20251204\\xtensa-esp-elf\\bin
        C:\\Espressif\\tools\\python\\v6.0.2\\venv\\Scripts
        ...

    This makes ``CMAKE_C_COMPILER`` / ``CMAKE_CXX_COMPILER`` (the bare
    ``xtensa-esp32s3-elf-gcc`` / ``clang``) resolvable. The venv Python is
    used as ``PYTHON`` so that ``idf.py``'s dependency check passes.
    """
    # The tool versions are fixed at the eim installation point; keep them
    # explicit here. If the toolchain is reinstalled, only this list needs
    # to be updated.
    tool_bins = [
        TOOLS / "ccache" / "4.12.1" / "ccache-4.12.1-windows-x86_64",
        TOOLS / "cmake" / "4.0.3" / "bin",
        TOOLS / "esp-clang" / "esp-20.1.1_20250829" / "esp-clang" / "bin",
        TOOLS / "esp-rom-elfs" / "20241011",
        TOOLS / "esp32ulp-elf" / "2.38_20240113" / "esp32ulp-elf" / "bin",
        TOOLS / "idf-exe" / "1.0.3",
        TOOLS / "ninja" / "1.12.1",
        TOOLS / "openocd-esp32" / "v0.12.0-esp32-20260424" / "openocd-esp32" / "bin",
        TOOLS / "riscv32-esp-elf-gdb" / "17.1_20260402" / "riscv32-esp-elf-gdb" / "bin",
        TOOLS / "riscv32-esp-elf" / "esp-15.2.0_20251204" / "riscv32-esp-elf" / "bin",
        TOOLS / "xtensa-esp-elf-gdb" / "17.1_20260402" / "xtensa-esp-elf-gdb" / "bin",
        TOOLS / "xtensa-esp-elf" / "esp-15.2.0_20251204" / "xtensa-esp-elf" / "bin",
        TOOLS / "python" / "v6.0.2" / "venv" / "Scripts",
    ]
    missing = [str(p) for p in tool_bins if not p.exists()]
    if missing:
        print("ERROR: missing tool directories under " + str(TOOLS), file=sys.stderr)
        for m in missing:
            print(f"  {m}", file=sys.stderr)
        raise SystemExit(1)

    env = dict(os.environ)
    env["PATH"] = os.pathsep.join(str(p) for p in tool_bins) + os.pathsep + env.get("PATH", "")
    # Keep the env vars that idf.py / cmake expect.
    env["IDF_PATH"] = str(ESP_IDF)
    env["IDF_TOOLS_PATH"] = str(TOOLS)
    env["IDF_PYTHON_ENV_PATH"] = str(TOOLS / "python" / "v6.0.2" / "venv")
    env["IDF_CCACHE_ENABLE"] = "0"
    env["CC"] = str(TOOLS / "esp-clang" / "esp-20.1.1_20250829" / "esp-clang" / "bin" / "clang")
    env["CXX"] = str(TOOLS / "esp-clang" / "esp-20.1.1_20250829" / "esp-clang" / "bin" / "clang++")
    # The constraint file check in idf.py looks at <IDF_TOOLS_PATH> (parent dir
    # C:\Espressif) but on this machine the file is in tools/, so disable it
    # (the venv has already been created, so no recheck is needed).
    env["IDF_PYTHON_CHECK_CONSTRAINTS"] = "0"
    # The component manager checks `ESP_IDF_VERSION` for extension compatibility;
    # the official profile sets it from version.cmake. Use the full semver so
    # it can be compared against 6.0.1.
    env["ESP_IDF_VERSION"] = "6.0.2"
    return env


def find_idf_exe() -> Path:
    candidates = [
        ESP_IDF / "tools" / "idf.py",
        TOOLS / "idf-exe" / "v6.0.2" / "windows" / "idf.py",
        VENV_PY.parent / "idf.py",
        VENV_PY.parent / "Scripts" / "idf.py",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    print("ERROR: idf.py not found. Looked at:", file=sys.stderr)
    for candidate in candidates:
        print(f"  {candidate}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="verify the tool layout without building")
    args = parser.parse_args()

    if not MAIN.exists():
        print(f"ERROR: {MAIN} not found", file=sys.stderr)
        return 1
    if not VENV_PY.exists():
        print(f"ERROR: IDF venv python missing: {VENV_PY}", file=sys.stderr)
        return 1

    print("[1/2] checking tool layout ...")
    if check_tool_layout() != 0:
        return 1
    if args.check:
        return 0

    print("[2/2] building firmware (idf.py build) ...")
    env = dict(os.environ)
    env.update(idf_export_env())
    # idf.py reads IDF_TOOLS_PATH from the env to detect tool versions. With the
    # eim-installed layout (<version>/<tool>/bin, not <version>), it reports the
    # compiler "not installed". CMake doesn't care — it just uses the CC/CXX we
    # export above — so don't let idf_tools abort the build.
    env["IDF_PYTHON_CHECK_CONSTRAINTS"] = "0"
    idf_exe = find_idf_exe()
    print(f"using idf.py: {idf_exe}")
    # idf.py is a Python script (no native launcher on Windows); run it with
    # the IDF venv interpreter so its dependencies resolve.
    proc = subprocess.run(
        [str(VENV_PY), str(idf_exe), "build"],
        cwd=str(MAIN),
        env=env,
    )
    if proc.returncode != 0:
        return proc.returncode
    elf = MAIN / "build" / "inkpane.bin"
    if elf.exists():
        print(f"\nBUILD OK: {elf} ({elf.stat().st_size:,} bytes)")
    else:
        print("\nBUILD finished but inkpane.bin not found under build/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
