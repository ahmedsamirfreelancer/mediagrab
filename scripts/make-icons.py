"""Generates the MediaGrab brand mark (download arrow into a tray, violet gradient squircle).
Run: python scripts/make-icons.py  -> build/icon.png|ico, installer BMPs, server/public/icon.png|favicon.png, android mipmaps."""
import os, sys
from PIL import Image, ImageDraw, ImageFilter
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024
C1, C2 = (124, 92, 255), (168, 85, 247)

def arrow(d, scale=1.0, ox=0, oy=0, w=96, color=(255, 255, 255, 255)):
    def p(x, y): return (ox + (S/2 + (x - S/2) * scale), oy + (S/2 + (y - S/2) * scale))
    def line(a, b):
        a, b = p(*a), p(*b); r = w * scale / 2
        d.line([a, b], fill=color, width=int(w * scale))
        for q in (a, b): d.ellipse([q[0]-r, q[1]-r, q[0]+r, q[1]+r], fill=color)
    line((512, 250), (512, 600))
    line((370, 470), (512, 612)); line((654, 470), (512, 612))
    line((330, 760), (694, 760))
    line((330, 760), (330, 690)); line((694, 760), (694, 690))

def mark(with_bg=True, scale=1.0):
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    if with_bg:
        g = Image.new('RGBA', (S, S))
        px = g.load()
        for y in range(S):
            for x in range(S):
                t = (x + y) / (2 * S)
                px[x, y] = tuple(int(C1[i] + (C2[i] - C1[i]) * t) for i in range(3)) + (255,)
        m = Image.new('L', (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, S-1, S-1], radius=230, fill=255)
        im.paste(g, (0, 0), m)
        # soft inner highlight
        hl = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(hl).ellipse([-300, -520, 1000, 330], fill=(255, 255, 255, 26))
        im.alpha_composite(Image.composite(hl, Image.new('RGBA', (S, S), (0,0,0,0)), m))
    lay = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    arrow(ImageDraw.Draw(lay), scale)
    sh = lay.filter(ImageFilter.GaussianBlur(14)); sh = Image.eval(sh, lambda v: v)
    shadow = Image.new('RGBA', (S, S), (40, 10, 110, 0)); shadow.putalpha(sh.getchannel('A').point(lambda a: int(a * .35)))
    off = Image.new('RGBA', (S, S), (0, 0, 0, 0)); off.paste(shadow, (0, 14))
    im.alpha_composite(off); im.alpha_composite(lay)
    return im

def out(path): 
    p = os.path.join(ROOT, path); os.makedirs(os.path.dirname(p), exist_ok=True); return p

full = mark()
full.resize((512, 512), Image.LANCZOS).save(out('build/icon.png'))
full.resize((512, 512), Image.LANCZOS).save(out('server/public/icon.png'))
full.resize((64, 64), Image.LANCZOS).save(out('server/public/favicon.png'))
full.save(out('build/icon.ico'), sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])

def bmp(path, w, h, bg, markpx, pos):
    im = Image.new('RGB', (w, h), bg)
    m = full.resize((markpx, markpx), Image.LANCZOS)
    im.paste(m, pos, m)
    im.save(out(path), 'BMP')
bmp('build/installerSidebar.bmp', 164, 314, (21, 19, 31), 110, (27, 60))
bmp('build/installerHeader.bmp', 150, 57, (255, 255, 255), 44, (98, 6))

# android launcher
fg = mark(False, 0.78)
for dens, sz in (('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)):
    d = f'android-app/android/app/src/main/res/mipmap-{dens}/'
    full.resize((sz, sz), Image.LANCZOS).save(out(d + 'ic_launcher.png'))
    rm = Image.new('RGBA', (sz, sz), (0,0,0,0)); mm = Image.new('L', (sz, sz), 0)
    ImageDraw.Draw(mm).ellipse([0, 0, sz-1, sz-1], fill=255)
    rm.paste(full.resize((sz, sz), Image.LANCZOS), (0, 0), mm); rm.save(out(d + 'ic_launcher_round.png'))
    fsz = int(sz * 108 / 48)
    fg.resize((fsz, fsz), Image.LANCZOS).save(out(d + 'ic_launcher_foreground.png'))
print('ok')
