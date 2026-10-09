"""Rebuilds JetBrainsMono-ascii.woff2, the face the ASCII animals are set in.

Upstream: JetBrains Mono 2.304, the variable upright file of the official release archive,
https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip
archive SHA-256 6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf
file fonts/variable/JetBrainsMono[wght].ttf, SHA-256 below.
Licence: SIL Open Font License 1.1, in JetBrainsMono-LICENSE.txt beside this file. The licence
declares no Reserved Font Name.

    python -m pip install --target <tools> fonttools==4.66.1 brotli==1.2.0
    PYTHONPATH=<tools> python apps/web/src/design/ascii/fonts/build.py "<folder with JetBrainsMono[wght].ttf>"

Characters: printable ASCII only, U+0020 to U+007E. The animals use ten of them; the word
Prix and a label use letters. No ligature, no contextual alternate: one character is one cell.
The weight axis is cut to 400 to 800.
"""

import hashlib
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = Path(__file__).resolve().parent
SHA256 = "662a196d58f1183bf2d77428b6d5283fe3f45161ab021bea4036bc98e5cac016"
UNICODES = list(range(0x0020, 0x007F))

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    source = Path(sys.argv[1]) / "JetBrainsMono[wght].ttf"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != SHA256:
        raise SystemExit(f"{source.name} is not the upstream file this recipe was written for: {digest}")
    font = TTFont(source, recalcTimestamp=False)
    options = subset.Options()
    options.layout_features = []
    options.name_languages = [0x409]
    options.notdef_outline = True
    options.glyph_names = False
    options.hinting = False
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)
    font = instancer.instantiateVariableFont(font, {"wght": (400, 800)})
    font["fvar"].instances = []
    missing = sorted(set(UNICODES) - set(font.getBestCmap()))
    if missing:
        raise SystemExit("no glyph for " + " ".join(f"U+{code:04X}" for code in missing))
    font.flavor = "woff2"
    target = HERE / "JetBrainsMono-ascii.woff2"
    font.save(target)
    axes = ", ".join(f"{axis.axisTag} {axis.minValue:g} to {axis.maxValue:g}" for axis in font["fvar"].axes)
    advance = font["hmtx"]["at"][0] / font["head"].unitsPerEm
    print(f"{target.name}: {source.stat().st_size} -> {target.stat().st_size} bytes; axes: {axes}; advance {advance:g} em")
