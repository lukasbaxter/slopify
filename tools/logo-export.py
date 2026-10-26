#!/usr/bin/env python3
"""Every icon slot from web/public/favicon.svg (the logo's source of truth).
Headless Brave (or Chrome) draws the SVG at 1024 px (full colour, and a white silhouette
for Android's monochrome layer); PIL cuts the sizes and backgrounds.

  python3 tools/logo-export.py           every slot
  python3 tools/logo-export.py splash    only the iOS launch screens (web/public/splash)
CHROME=/path/to/chrome overrides the browser."""
import os, re, subprocess, sys, tempfile
from PIL import Image, ImageChops

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = os.environ.get('CHROME') or next(p for p in ('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
                          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') if os.path.exists(p))
SVG = open(f'{R}/web/public/favicon.svg').read()

def render(svg, size=1024):
    with tempfile.TemporaryDirectory() as d:
        open(f'{d}/i.html', 'w').write(f'<style>html,body{{margin:0;background:transparent}}svg{{width:{size}px;height:{size}px;display:block}}</style>{svg}')
        subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
                        f'--window-size={size},{size}', f'--screenshot={d}/o.png', f'file://{d}/i.html'], capture_output=True, check=True)
        return Image.open(f'{d}/o.png').convert('RGBA').crop((0, 0, size, size))

full = render(SVG)

# silhouette: the shape in white with the bars cut out (dark fills become holes)
light = render(re.sub(r'#121212', '#000000', SVG))
lum = light.convert('L'); alpha = light.getchannel('A')
mono = Image.new('RGBA', light.size, (255, 255, 255, 0))
mono.putalpha(ImageChops.multiply(alpha, lum.point(lambda v: 255 if v > 60 else 0)))

def at(im, size): return im.resize((size, size), Image.LANCZOS)
def on_bg(im, size, frac, bg=(0, 0, 0, 255)):
    out = Image.new('RGBA', (size, size), bg); d = round(size * frac)
    out.alpha_composite(at(im, d), ((size - d) // 2, (size - d) // 2)); return out

# iOS launch screens (apple-touch-startup-image, linked from web/index.html):
# the logo, 96pt wide, centred on the app's page colour, one per screen
# size and orientation. iOS shows a blank frame for a size it has no image for.
SCREENS = [  # points w x h, scale
    (440, 956, 3), (420, 912, 3), (402, 874, 3), (430, 932, 3), (393, 852, 3), (428, 926, 3), (390, 844, 3),
    (414, 896, 3), (414, 896, 2), (375, 812, 3), (414, 736, 3), (375, 667, 2), (320, 568, 2),
    (1032, 1376, 2), (1024, 1366, 2), (834, 1210, 2), (834, 1194, 2), (820, 1180, 2), (834, 1112, 2),
    (810, 1080, 2), (768, 1024, 2), (744, 1133, 2),
]
def splash():
    os.makedirs(f'{R}/web/public/splash', exist_ok=True)
    for w, h, s in SCREENS:
        for pw, ph in ((w * s, h * s), (h * s, w * s)):
            out = Image.new('RGB', (pw, ph), (18, 18, 18)); d = 96 * s
            out.paste(at(full, d), ((pw - d) // 2, (ph - d) // 2), at(full, d))
            out.save(f'{R}/web/public/splash/{pw}x{ph}.png', optimize=True)
if sys.argv[1:] == ['splash']:
    splash(); print('splash exported'); sys.exit()

W, M = f'{R}/web/public', f'{R}/mobile/assets'
at(full, 192).save(f'{W}/icon-192.png'); at(full, 512).save(f'{W}/icon-512.png')
on_bg(full, 512, 0.80, (0, 0, 0, 0)).save(f'{W}/icon-maskable-512.png')
at(full, 180).save(f'{W}/apple-touch-icon.png')
at(full, 256).save(f'{W}/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
at(full, 1024).save(f'{R}/desktop/build/icon.png'); at(full, 1024).save(f'{M}/icon.png'); at(full, 48).save(f'{M}/favicon.png')
Image.new('RGBA', (512, 512), (0, 0, 0, 255)).save(f'{M}/android-icon-background.png')
on_bg(full, 512, 0.60, (0, 0, 0, 0)).save(f'{M}/android-icon-foreground.png')
on_bg(mono, 432, 0.60, (0, 0, 0, 0)).save(f'{M}/android-icon-monochrome.png')
on_bg(full, 1024, 0.45).save(f'{M}/splash-icon.png')
splash()
print('exported')
