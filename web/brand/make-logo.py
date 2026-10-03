# Regenerates web/public/logo.svg, favicon.svg (and logo.png with: rsvg-convert -w 1024 web/public/logo.svg -o web/public/logo.png).
# Usage: python3 web/brand/make-logo.py <DMSans[opsz,wght].ttf from github.com/google/fonts ofl/dmsans> web/public
# DM Sans is under the SIL Open Font License 1.1; only glyph outlines are shipped, not the font. Needs fonttools.
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

font = instantiateVariableFont(TTFont(sys.argv[1]), {"wght": 700, "opsz": 20})
upm = font["head"].unitsPerEm
gs = font.getGlyphSet(); cmap = font.getBestCmap(); hmtx = font["hmtx"]
TRACK = -0.02 * upm
ACCENT, TEXT = "#cf4a12", "#1d1d1f"

def outline(text, colors):
    x = 0; parts = []; bounds = BoundsPen(gs)
    for ch, color in zip(text, colors):
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs, ntos=lambda v: ("%.1f" % v).rstrip("0").rstrip("."))
        gs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))  # flip y for SVG
        gs[name].draw(TransformPen(bounds, (1, 0, 0, 1, x, 0)))
        parts.append((color, pen.getCommands()))
        x += hmtx[name][0] + TRACK
    xmin, ymin, xmax, ymax = bounds.bounds
    pad = 0.04 * upm
    vb = (xmin - pad, -ymax - pad, xmax - xmin + 2 * pad, ymax - ymin + 2 * pad)
    return parts, vb

def svg(text, colors, label):
    parts, (vx, vy, vw, vh) = outline(text, colors)
    paths = "\n".join(f'  <path fill="{c}" d="{d}"/>' for c, d in parts)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vx:.0f} {vy:.0f} {vw:.0f} {vh:.0f}" role="img" aria-label="{label}">\n'
            f"  <title>{label}</title>\n{paths}\n</svg>\n")

open(sys.argv[2] + "/logo.svg", "w").write(svg("&run", [ACCENT, TEXT, TEXT, TEXT], "&amp;run"))
open(sys.argv[2] + "/favicon.svg", "w").write(svg("&", [ACCENT], "&amp;run"))
