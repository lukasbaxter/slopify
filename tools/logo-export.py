#!/usr/bin/env python3
"""Every icon slot from web/public/favicon.svg (the logo's source of truth).
Headless Chrome draws the SVG at 1024 px (full colour, and a white silhouette
for Android's monochrome layer); PIL cuts the sizes and backgrounds.

  python3 tools/logo-export.py"""
import os, re, subprocess, tempfile
from PIL import Image, ImageChops

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
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

W, M = f'{R}/web/public', f'{R}/mobile/assets'
at(full, 192).save(f'{W}/icon-192.png'); at(full, 512).save(f'{W}/icon-512.png')
on_bg(full, 512, 0.72).save(f'{W}/icon-maskable-512.png')
on_bg(full, 180, 0.80).convert('RGB').save(f'{W}/apple-touch-icon.png')
at(full, 256).save(f'{W}/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
at(full, 1024).save(f'{R}/desktop/build/icon.png'); at(full, 1024).save(f'{M}/icon.png'); at(full, 48).save(f'{M}/favicon.png')
Image.new('RGBA', (512, 512), (0, 0, 0, 255)).save(f'{M}/android-icon-background.png')
on_bg(full, 512, 0.60, (0, 0, 0, 0)).save(f'{M}/android-icon-foreground.png')
on_bg(mono, 432, 0.60, (0, 0, 0, 0)).save(f'{M}/android-icon-monochrome.png')
on_bg(full, 1024, 0.45).save(f'{M}/splash-icon.png')
print('exported')
