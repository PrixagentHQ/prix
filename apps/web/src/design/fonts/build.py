"""Rebuilds Inter-latin.woff2, the one face of the site.

Upstream: Inter 4.1, the variable upright file of the official release,
https://raw.githubusercontent.com/rsms/inter/v4.1/docs/font-files/InterVariable.woff2
SHA-256 693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3
Licence: SIL Open Font License 1.1, in Inter-LICENSE.txt beside this file. The licence of
Inter 4 declares no Reserved Font Name, so the family keeps its name.

    python -m pip install --target .artifacts/pytools fonttools==4.66.1 brotli==1.2.0
    PYTHONPATH=.artifacts/pytools python apps/web/src/design/fonts/build.py <folder with InterVariable.woff2>

The character set is the one README.md beside this file lists.
The weight axis is cut to 400 to 700; the optical size axis (14 to 32) stays whole, so a
28 pixel figure is set in the display cut.
"""

import hashlib
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = Path(__file__).resolve().parent
SHA256 = "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3"
RANGES = [(0x0020, 0x007E), (0x00A0, 0x00FF)]
SINGLES = [
    0x2007, 0x2009, 0x2010, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D,
    0x2022, 0x2026, 0x202F, 0x2212, 0x2248, 0x2260, 0x2264, 0x2265,
]
# Inter has no glyph for the soft hyphen, U+00AD, which is never drawn.
UNICODES = [code for first, last in RANGES for code in range(first, last + 1) if code != 0x00AD] + SINGLES
FEATURES = ["kern", "liga", "calt", "ccmp", "lnum", "tnum", "pnum"]

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    source = Path(sys.argv[1]) / "InterVariable.woff2"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != SHA256:
        raise SystemExit(f"{source.name} is not the upstream file this recipe was written for: {digest}")
    font = TTFont(source, recalcTimestamp=False)
    options = subset.Options()
    options.layout_features = FEATURES
    options.name_languages = [0x409]
    options.notdef_outline = True
    options.glyph_names = False
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)
    font = instancer.instantiateVariableFont(font, {"wght": (400, 700)})
    font["fvar"].instances = []
    missing = sorted(set(UNICODES) - set(font.getBestCmap()))
    if missing:
        raise SystemExit("no glyph for " + " ".join(f"U+{code:04X}" for code in missing))
    font.flavor = "woff2"
    target = HERE / "Inter-latin.woff2"
    font.save(target)
    axes = ", ".join(f"{axis.axisTag} {axis.minValue:g} to {axis.maxValue:g}" for axis in font["fvar"].axes)
    print(f"Inter-latin.woff2: {source.stat().st_size} -> {target.stat().st_size} bytes; axes: {axes}")
