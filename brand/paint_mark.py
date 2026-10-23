"""The aperture, painted. Each of the nine blades is its own brushed shape, streaked along its curve, with a
hand-cut edge, and the seams are the gaps the brush left. The opening glows warm, brushed upright and
hottest in the middle: the hidden objective, seen through the auditor's iris. (A slit there instead reads
as a reptile's pupil.) Painted at 4096 px from a fixed seed, so it comes out the same every time."""
import math
import random

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

S, C = 4096, 2048.0
PLATE, INK, HALATION, HOT = (7, 9, 8), (232, 234, 230), (255, 90, 43), (255, 196, 170)


class Painter:
    def __init__(self, seed):
        self.rng = random.Random(seed)
        self.np = np.random.default_rng(seed)

    def field(self, scale, amp):
        """Smooth 2D noise: random values, upsampled and blurred."""
        small = Image.fromarray((self.np.random((S // scale, S // scale)) * 255).astype(np.uint8))
        a = np.asarray(small.resize((S, S), Image.BICUBIC).filter(ImageFilter.GaussianBlur(scale / 2)), float) / 255 - 0.5
        return a / (np.abs(a).max() or 1) * amp

    def roughen(self, mask, amp, scale):
        """Displaces a mask's edge with noise, so it looks cut by hand."""
        m = np.asarray(mask, float)
        yy, xx = np.mgrid[0:S, 0:S]
        xs = np.clip(xx + self.field(scale, amp), 0, S - 1).astype(int)
        ys = np.clip(yy + self.field(scale, amp), 0, S - 1).astype(int)
        return Image.fromarray(m[ys, xs].astype(np.uint8))

    def streaks(self, draw, a, b, count, alpha, thick, wobble):
        """Brush strokes across a blade, each following a curve between its two seams."""
        for _ in range(count):
            f = self.rng.random()
            line = a * (1 - f) + b * f
            n = len(line)
            wob = np.convolve(self.np.normal(0, 1, n).cumsum(), np.ones(30) / 30, mode="same")
            wob = (wob - wob.mean()) / (np.abs(wob).max() or 1) * wobble
            d = np.gradient(line, axis=0)
            d /= np.linalg.norm(d, axis=1, keepdims=True) + 1e-9
            line = line + np.stack([-d[:, 1], d[:, 0]], 1) * wob[:, None]
            s, e = int(self.rng.uniform(0, 0.12) * n), n - int(self.rng.uniform(0, 0.1) * n)
            draw.line([tuple(p) for p in line[s:e]], fill=int(self.rng.uniform(*alpha)), width=int(self.rng.uniform(*thick)), joint="curve")


def quad(p0, q, p1, n):
    s = np.linspace(0, 1, n)[:, None]
    return (1 - s) ** 2 * np.array(p0) + 2 * (1 - s) * s * np.array(q) + s ** 2 * np.array(p1)


def seams(R, ri, n=9, bend=0.2):
    """The opening is a nonagon; each seam carries one of its sides on to the rim, bowed like an iris blade."""
    verts = [(C + ri * math.cos(-math.pi / 2 + 2 * math.pi * i / n), C + ri * math.sin(-math.pi / 2 + 2 * math.pi * i / n)) for i in range(n)]
    out = []
    for i in range(n):
        (x0, y0), (x1, y1) = verts[i - 1], verts[i]
        L = math.hypot(x1 - x0, y1 - y0)
        ux, uy = (x1 - x0) / L, (y1 - y0) / L
        b = (x1 - C) * ux + (y1 - C) * uy
        t = -b + math.sqrt(b * b - ((x1 - C) ** 2 + (y1 - C) ** 2 - R * R))
        ex, ey = x1 + ux * t, y1 + uy * t
        out.append(quad((x1, y1), ((x1 + ex) / 2 - uy * bend * t, (y1 + ey) / 2 + ux * bend * t), (ex, ey), 240))
    return out


def layer(color, alpha):
    return Image.merge("RGBA", (*[Image.new("L", (S, S), c) for c in color], alpha))


def painted_mark(seed=3, R=1640, ri=640, gap=24):
    """The mark on a transparent background, 4096 px square."""
    p = Painter(seed)
    edges = seams(R, ri)
    blades = Image.new("L", (S, S), 0)
    shade = Image.new("L", (S, S), 0)
    sd = ImageDraw.Draw(shade)
    for i in range(9):
        a, b = edges[i], edges[(i + 1) % 9]
        t0, t1 = math.atan2(a[-1, 1] - C, a[-1, 0] - C), math.atan2(b[-1, 1] - C, b[-1, 0] - C)
        if t1 < t0:
            t1 += 2 * math.pi
        rim = [(C + R * math.cos(t), C + R * math.sin(t)) for t in np.linspace(t0, t1, 60)]
        m = Image.new("L", (S, S), 0)
        ImageDraw.Draw(m).polygon([tuple(q) for q in a] + rim + [tuple(q) for q in b[::-1]], fill=255)
        # Shrink each blade away from its neighbours to leave the seam.
        m = m.filter(ImageFilter.GaussianBlur(gap)).point(lambda v: 255 if v > 235 else 0)
        blades = ImageChops.lighter(blades, m)
        p.streaks(sd, a, b, count=260, alpha=(170, 255), thick=(8, 26), wobble=14)
    blades = p.roughen(blades, amp=22, scale=80)
    # Streaks over a slightly darker base coat, so the ink varies like gouache.
    paint = ImageChops.multiply(blades, ImageChops.lighter(blades.point(lambda v: int(v * 0.86)), shade))

    opening = Image.new("L", (S, S), 0)
    ImageDraw.Draw(opening).polygon([(C + (ri + 30) * math.cos(-math.pi / 2 + 2 * math.pi * i / 9), C + (ri + 30) * math.sin(-math.pi / 2 + 2 * math.pi * i / 9)) for i in range(9)], fill=255)
    opening = p.roughen(opening, amp=10, scale=220).filter(ImageFilter.GaussianBlur(3))
    # The light: hottest along an upright core, like the site's light leak, with brush streaks through it.
    half = int(ri * 1.3)
    box = (int(C) - half, int(C) - half)
    yy, xx = np.mgrid[box[1]:box[1] + 2 * half, box[0]:box[0] + 2 * half].astype(np.float32)
    core = np.clip(1 - np.sqrt(((xx - C) / (ri * 0.42)) ** 2 + ((yy - C) / (ri * 1.15)) ** 2), 0, 1) ** 1.4
    tex = Image.new("L", (2 * half, 2 * half), 128)
    td = ImageDraw.Draw(tex)
    for _ in range(240):
        x = half + p.rng.uniform(-1.15, 1.15) * ri
        y0, y1 = half - ri * p.rng.uniform(0.85, 1.25), half + ri * p.rng.uniform(0.85, 1.25)
        bow = p.rng.uniform(-70, 70)
        td.line([(x + p.rng.gauss(0, 2.5) + bow * math.sin(math.pi * k / 24), y0 + (y1 - y0) * k / 24) for k in range(25)],
                fill=int(p.rng.uniform(60, 200)), width=int(p.rng.uniform(10, 36)), joint="curve")
    shade_warm = 0.92 + 0.3 * (np.asarray(tex.filter(ImageFilter.GaussianBlur(5)), np.float32) / 255 - 0.5)
    rgb = (np.array(HALATION, np.float32) * (1 - core[..., None]) + np.array(HOT, np.float32) * core[..., None]) * shade_warm[..., None]
    warm = Image.new("RGB", (S, S), HALATION)
    warm.paste(Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB"), box)
    lit = warm.convert("RGBA")
    lit.putalpha(opening)

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.alpha_composite(lit)
    img.alpha_composite(layer(INK, paint))
    return img


def icon_tile(mark, inset=0.86, radius=0.1875):
    """The mark on its plate-black rounded tile, 4096 px square."""
    t = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * radius), fill=255)
    t.paste(Image.new("RGBA", (S, S), (*PLATE, 255)), mask=m)
    inner = mark.resize((int(S * inset), int(S * inset)), Image.LANCZOS)
    t.alpha_composite(inner, ((S - inner.width) // 2, (S - inner.height) // 2))
    return t
