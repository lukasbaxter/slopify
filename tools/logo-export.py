import sys
from PIL import Image
from logo import build, svg, png
R = '/Users/lukasbaxter/Projects/slopify'
KW = dict(seed=21, rings=(1, 6, 11, 16, 21), jitter=0.45)   # design B
faces = build(**KW)
n_disc = len(build(**KW, bars=False))
def on_bg(size, frac, bg=(0, 0, 0, 255), f=faces):
    im = Image.new('RGBA', (size, size), bg)
    d = round(size * frac); im.alpha_composite(png(f, d), ((size - d) // 2, (size - d) // 2)); return im
# web
open(f'{R}/web/public/favicon.svg', 'w').write(svg(faces))
png(faces, 192).save(f'{R}/web/public/icon-192.png')
png(faces, 512).save(f'{R}/web/public/icon-512.png')
on_bg(512, 0.80).save(f'{R}/web/public/icon-maskable-512.png')
on_bg(180, 0.86).convert('RGB').save(f'{R}/web/public/apple-touch-icon.png')
png(faces, 256).save(f'{R}/web/public/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
# desktop + mobile
png(faces, 1024).save(f'{R}/desktop/build/icon.png')
png(faces, 1024).save(f'{R}/mobile/assets/icon.png')
png(faces, 48).save(f'{R}/mobile/assets/favicon.png')
Image.new('RGBA', (512, 512), (0, 0, 0, 255)).save(f'{R}/mobile/assets/android-icon-background.png')
on_bg(512, 0.62, bg=(0, 0, 0, 0)).save(f'{R}/mobile/assets/android-icon-foreground.png')
mono = [(p, (1, 1, 1)) for p, _ in faces[:n_disc]]
m = png(mono, 432 * 62 // 100); bars = png([(p, (0, 0, 0)) for p, _ in faces[n_disc:]], m.size[0])
a = m.getchannel('A').point(lambda v: v)
cut = Image.eval(bars.getchannel('A'), lambda v: 255 - v)
from PIL import ImageChops
m.putalpha(ImageChops.multiply(a, cut))
mono_im = Image.new('RGBA', (432, 432), (0, 0, 0, 0)); mono_im.alpha_composite(m, ((432 - m.size[0]) // 2,) * 2)
mono_im.save(f'{R}/mobile/assets/android-icon-monochrome.png')
on_bg(1024, 0.5).save(f'{R}/mobile/assets/splash-icon.png')
print('svg bytes', len(svg(faces)), '| faces', len(faces), 'disc', n_disc)
