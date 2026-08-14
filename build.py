#!/usr/bin/env python3
"""Assemble FLOWLINE into a single self-contained html file."""
import pathlib, re, shutil, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "flowline.html")

ORDER = [
    "util.js",
    "stamps.js",
    "terrain_core.js",
    "terrain_feat.js",
    "shadow.js",
    "deform.js",
    "terrain_mesh.js",
    "terrain_fine.js",
    "terrain_skirt.js",     # PB8 far skirt. Kept IN because it is already live in
                            # prod (a cron occurrence shipped it mid-session), so
                            # dropping it would regress the fix for the edge of the
                            # world. main.js guards on `typeof TerrainSkirt`, so it
                            # can be pulled again by commenting this out.
    "sky.js",
    "audio.js",
    "music.js",
    "props_geo.js",
    "props_geo2.js",
    "props_col.js",         # PB9 solid-prop colliders. Must precede every
                            # producer (furniture/build/park) and props_world.
    "props_furniture.js",
    "props_build.js",
    "props_park.js",
    "props_world.js",
    "fx.js",
    "wake.js",
    "weather.js",
    "rider_geo.js",
    "rider_rig.js",
    "rider_build.js",
    "rider_body.js",
    "rider.js",
    "rider2.js",
    "net.js",
    "bots.js",
    "auto.js",
    "ui.js",
    "timer.js",
    "main.js",
    "trailer.js",
]

def check(code):
    """A parse error makes the module silently never run (no error box), so
    gate every build on a real js parse. Skipped when bun is not installed,
    so the build has no dependency beyond python3."""
    if shutil.which("bun") is None:
        print("note: bun not found -> skipping js syntax check")
        return
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(code)
        tmp = f.name
    r = subprocess.run(["bun", "build", tmp, "--target", "browser"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr or r.stdout)
        sys.exit("syntax check FAILED")


def main():
    shell = (ROOT / "shell.html").read_text()
    parts = []
    for name in ORDER:
        p = SRC / name
        if not p.exists():
            print("skip missing", name)
            continue
        parts.append(f"\n// ===== {name} =====\n" + p.read_text())
    code = "\n".join(parts)
    check(code)
    html = shell.replace("/*__GAME_CODE__*/", code)
    OUT.write_text(html)
    kb = len(html) / 1024
    print(f"wrote {OUT} ({kb:.1f} KB)")

main()
