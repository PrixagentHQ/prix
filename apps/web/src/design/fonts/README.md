# Fonts

One file: a subset of Inter 4.1 under the SIL Open Font License 1.1. The licence of Inter 4 declares no Reserved Font Name, so the family keeps its name. The licence text stays beside the file (`Inter-LICENSE.txt`) and must ship with it.

| File | Family name | Bytes | Made from |
|---|---|---|---|
| `Inter-latin.woff2` | Inter | 39,288 | Inter 4.1, `InterVariable.woff2` |

It replaces the two files of direction A (Prix Serif and Prix Sans, 89,420 bytes together).

## Upstream file

The unmodified release file. `build.py` checks the SHA-256 before it reads it.

| File | Release | Address | SHA-256 |
|---|---|---|---|
| `InterVariable.woff2` | rsms/inter, tag `v4.1` | `https://raw.githubusercontent.com/rsms/inter/v4.1/docs/font-files/InterVariable.woff2` | `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` |

The upstream file is not in this repository.

## Rebuild

Python 3.11 with fonttools 4.66.1 and brotli 1.2.0. They are tools run by hand, not dependencies of the project. From the repository root:

```
mkdir -p .artifacts/fonts/upstream
curl -L -o .artifacts/fonts/upstream/InterVariable.woff2 https://raw.githubusercontent.com/rsms/inter/v4.1/docs/font-files/InterVariable.woff2
python -m pip install --target .artifacts/pytools fonttools==4.66.1 brotli==1.2.0
PYTHONPATH=.artifacts/pytools python apps/web/src/design/fonts/build.py .artifacts/fonts/upstream
```

The script writes the file into this folder and prints its size. The file in this folder is a copy of the one the approved study was drawn with (`../studies-v4/Inter-latin.woff2`):

```
eae036f364e5a3229255fb5a18070447d8f934c95ab8f638f9b4791dce726f3f  Inter-latin.woff2
```

`build.py` does three things, in this order:

1. Subsets the file with `fontTools.subset` to the characters and the OpenType features listed below.
2. Cuts the weight axis to 400 to 700 with `fontTools.varLib.instancer` and removes the named instances.
3. Saves it as WOFF2.

## What is in the file

Characters, 207:

| Range | What |
|---|---|
| U+0020 to U+007E | Basic Latin |
| U+00A0 to U+00FF, without U+00AD | Latin-1 Supplement. Inter has no glyph for the soft hyphen, which is never drawn |
| U+2007, U+2009, U+202F | Figure space, thin space, narrow no-break space |
| U+2010, U+2013, U+2014 | Hyphen, en dash, em dash |
| U+2018, U+2019, U+201C, U+201D | Curly quotation marks; U+2019 is the deck's apostrophe |
| U+2022, U+2026 | Bullet, ellipsis |
| U+2212, U+2248, U+2260, U+2264, U+2265 | Minus, almost equal, not equal, at most, at least |

The copy deck, the long-form pages, `content/format.ts` and the primitives use six characters beyond Latin-1 today: U+2013, U+2019, U+201C, U+201D, U+2026 and U+2212. The others are there so that an ordinary sentence in the deck or the methodology does not need a rebuild.

A character outside the set is drawn by the next face in the stack, the system's own sans. That can only happen in text from a user or a model: a published prompt, a summary, a reason. An agent's name is ASCII by contract.

Axes:

- Weight, 400 to 700. The site sets 400, 500, 600 and 700 (docs/DESIGN.md section 3). The upstream range is 100 to 900.
- Optical size, 14 to 32, whole. A 28 pixel figure is set in the display cut and a 14 pixel sentence in the text cut, which is why the stand-in faces in `../tokens.css` come in two sets.

OpenType features: kerning, the standard ligatures, contextual alternates, glyph composition, and the proportional and tabular lining figures that `font-variant-numeric` asks for. There is no italic file.

## The stand-in faces

`../tokens.css` declares `Inter Fallback` and `Inter Fallback Display`: Arial and Arial Bold with a `size-adjust` per weight, so a line set in the stand-in is as wide as the same line in Inter and the page does not rewrap when the file arrives. The widths were measured in Chromium on five of the site's own sentences:

| Weight | At 14 pixels, against | Inter over the local face |
|---|---|---|
| 400 | Arial | 1.0635 |
| 500 | Arial | 1.0733 |
| 600 | Arial Bold | 1.0172 |
| 700 | Arial Bold | 1.0264 |
| 600, at 28 pixels | Arial Bold | 0.9632 |
| 700, at 28 pixels | Arial Bold | 0.9789 |

## When the character set changes

1. Change `RANGES` or `SINGLES` in `build.py` and run it. It stops if the upstream file has no glyph for a character.
2. Put the same ranges in the `unicode-range` descriptor in `../tokens.css` and in the table above.
3. Update the size and the SHA-256 line in this file and the size in docs/DESIGN.md section 3.
