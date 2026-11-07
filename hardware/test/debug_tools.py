"""Debug: verify load_required_tools works in build_firmware.py."""
import json
from pathlib import Path

ESP_IDF = Path(r"C:\esp\v6.0.2\esp-idf")
raw = json.loads((ESP_IDF / "tools" / "tools.json").read_text(encoding="utf-8"))
tools_list = raw if isinstance(raw, list) else raw.get("tools", [])
out = {}
for info in tools_list:
    name = info.get("name")
    if not name:
        continue
    versions = info.get("versions")
    found = []
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

print(f"num tools: {len(out)}")
for k, v in sorted(out.items()):
    print(f"  {k} -> {v}")
