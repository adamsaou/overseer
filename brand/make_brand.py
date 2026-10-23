"""Builds Overseer's brand files in brand/: the painted aperture and its icon sizes, the wordmark, the lockups,
the README header and GitHub's social preview. Type is outlined from the site's own fonts (site/fonts/), so
nothing depends on installed fonts.

    uvx --with numpy --with pillow --with fonttools --with brotli python brand/make_brand.py

The README header and the social preview are drawn as SVG and rasterised with rsvg-convert (librsvg)."""
import base64
import io
import math
import subprocess
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image

from paint_mark import icon_tile, painted_mark

HERE = Path(__file__).resolve().parent
FONTS = HERE.parent / "site" / "fonts"

PLATE, INK, FAINT, HAIRLINE = "#070908", "#E8EAE6", "#858D89", "#1E2422"
HOOK = ("Can a weaker AI catch a stronger one", "that’s hiding something?")
KICKER = "AI SAFETY RESEARCH · BLACK-BOX AUDITS FOR HIDDEN OBJECTIVES"


def outlined(text, font, size, tracking=0.0, x=0.0, baseline=0.0, fill=INK):
    """Text as one path, so it needs no installed fonts. Returns the path element and the run's width."""
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    scale = size / font["head"].unitsPerEm
    out, pen_x = [], 0.0
    for i, ch in enumerate(text):
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x + pen_x, baseline)))
        out.append(pen.getCommands())
        pen_x += glyphs[name].width * scale + (tracking * size if i < len(text) - 1 else 0)
    return f'<path fill="{fill}" d="{"".join(out)}"/>', pen_x


def png_uri(img, px):
    buf = io.BytesIO()
    img.resize((px, px), Image.LANCZOS).save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def frame(w, h, inset):
    """The site's plate frame: a hairline inset, crop marks in the corners and registration targets."""
    m, k = inset, inset * 0.9
    marks = [f'<rect x="{m}" y="{m}" width="{w - 2 * m}" height="{h - 2 * m}" fill="none" stroke="{HAIRLINE}" stroke-width="2"/>']
    for cx, cy, sx, sy in ((m, m, 1, 1), (w - m, m, -1, 1), (m, h - m, 1, -1), (w - m, h - m, -1, -1)):
        marks.append(f'<path d="M{cx} {cy + sy * k}V{cy}H{cx + sx * k}" fill="none" stroke="#A3AAA6" stroke-width="2"/>')
    for cy in (m, h - m):
        marks.append(f'<circle cx="{w / 2}" cy="{cy}" r="9" fill="{PLATE}" stroke="#A3AAA6" stroke-width="2"/>'
                     f'<path d="M{w / 2 - 16} {cy}H{w / 2 + 16}M{w / 2} {cy - 16}V{cy + 16}" stroke="#A3AAA6" stroke-width="2"/>')
    return "".join(marks)


def banner(w, h, mark_uri, mono600, mono500, serif, mark_size, left, text_x, top, k=1.0):
    """k scales the text block, so one layout serves the README's wide header and GitHub's 2:1 card."""
    word, _ = outlined("OVERSEER", mono600, 64 * k, tracking=0.22, x=text_x, baseline=top + 110 * k)
    kicker, _ = outlined(KICKER, mono500, 17 * k, tracking=0.14, x=text_x, baseline=top + 30 * k, fill=FAINT)
    lines = "".join(outlined(t, serif, 50 * k, x=text_x, baseline=top + (196 + i * 62) * k)[0] for i, t in enumerate(HOOK))
    y = (h - mark_size) / 2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
            f'<rect width="{w}" height="{h}" fill="{PLATE}"/>{frame(w, h, 28)}'
            f'<image x="{left}" y="{y}" width="{mark_size}" height="{mark_size}" xlink:href="{mark_uri}"/>'
            f"{kicker}{word}{lines}</svg>\n")


def main():
    mono = TTFont(FONTS / "azeret-mono-200-600.woff2")
    mono600 = instantiateVariableFont(TTFont(FONTS / "azeret-mono-200-600.woff2"), {"wght": 600})
    mono500 = instantiateVariableFont(mono, {"wght": 500})
    serif = TTFont(FONTS / "plate-serif-display-300.woff2")

    mark = painted_mark()
    mark.resize((2048, 2048), Image.LANCZOS).save(HERE / "mark.png")
    tile = icon_tile(mark)
    for name, px in (("icon-1024.png", 1024), ("icon-512.png", 512), ("apple-touch-icon.png", 180), ("favicon-64.png", 64), ("favicon-32.png", 32), ("favicon-16.png", 16)):
        tile.resize((px, px), Image.LANCZOS).save(HERE / name)

    # The wordmark: Azeret Mono SemiBold, tracked 0.22 em, as on the site, on a 100-unit cap-height body.
    for name, fill in (("wordmark.svg", INK), ("wordmark-on-light.svg", PLATE)):
        word, width = outlined("OVERSEER", mono600, 140, tracking=0.22, baseline=100, fill=fill)
        (HERE / name).write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {math.ceil(width)} 100" width="{math.ceil(width)}" height="100" role="img"><title>Overseer</title>{word}</svg>\n')

    # Lockups: the tile, then the wordmark with its cap height a third of the tile's.
    tile_uri = png_uri(tile, 512)
    for name, fill, bg in (("lockup", INK, PLATE), ("lockup-on-light", PLATE, "#F2F2EF")):
        h, gap = 512, 150
        word, width = outlined("OVERSEER", mono600, 140 * (h / 3) / 100, tracking=0.22, x=h + gap, baseline=h / 2 + h / 6, fill=fill)
        w = h + gap + math.ceil(width)
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="-64 -64 {w + 128} {h + 128}" width="{w + 128}" height="{h + 128}">'
               f'<rect x="-64" y="-64" width="{w + 128}" height="{h + 128}" fill="{bg}"/><image width="{h}" height="{h}" xlink:href="{tile_uri}"/>{word}</svg>\n')
        (HERE / f"{name}.svg").write_text(svg)
        subprocess.run(["rsvg-convert", "-h", "320", str(HERE / f"{name}.svg"), "-o", str(HERE / f"{name}.png")], check=True)

    mark_uri = png_uri(mark, 720)
    layouts = {"readme-header": (1600, 520, 400, 96, 560, 124, 1.0), "social-preview": (1280, 640, 380, 72, 500, 200, 0.84)}
    for name, (w, h, size, left, text_x, top, k) in layouts.items():
        (HERE / f"{name}.svg").write_text(banner(w, h, mark_uri, mono600, mono500, serif, size, left, text_x, top, k))
        subprocess.run(["rsvg-convert", str(HERE / f"{name}.svg"), "-o", str(HERE / f"{name}.png")], check=True)
        (HERE / f"{name}.svg").unlink()
    for name in ("lockup.svg", "lockup-on-light.svg"):
        (HERE / name).unlink()  # they embed a raster; the PNGs are the files to use
    print("Wrote", ", ".join(sorted(p.name for p in HERE.iterdir() if p.suffix in (".svg", ".png"))))


if __name__ == "__main__":
    main()
