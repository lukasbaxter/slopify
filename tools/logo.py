"""Low-poly Slopify logo: a faceted green disc with three triangle-strip arcs."""
import math, random, colorsys, sys
from PIL import Image, ImageDraw

def build(seed=7, rings=(1, 7, 13, 19, 25), jitter=0.35, bars=True, bar_color=(0.07, 0.07, 0.07), base=(141/360, 0.72, 0.47)):
    rnd = random.Random(seed)
    R = 1.0
    # --- points on concentric rings (ring 0 = centre) ---
    pts = []
    nr = len(rings)
    for k, n in enumerate(rings):
        r = R * k / (nr - 1) * (1.12 if k == nr - 1 else 1.0)
        off = rnd.random() * 2 * math.pi
        ring = []
        for i in range(n):
            a = off + 2 * math.pi * i / n
            if 0 < k < nr - 1:
                a += (rnd.random() - .5) * jitter * 2 * math.pi / n
                rr = r + (rnd.random() - .5) * jitter * R / (nr - 1)
            else:
                rr = r
            ring.append((rr * math.cos(a), rr * math.sin(a), a % (2 * math.pi)))
        ring.sort(key=lambda p: p[2])
        pts.append(ring)
    # --- stitch neighbouring rings by walking both in angle order ---
    tris = []
    for k in range(nr - 1):
        A, B = pts[k], pts[k + 1]
        if len(A) == 1:
            for j in range(len(B)): tris.append((A[0], B[j], B[(j + 1) % len(B)]))
            continue
        i = j = 0
        # align start of B to A[0]
        j0 = min(range(len(B)), key=lambda j: abs((B[j][2] - A[0][2] + math.pi) % (2 * math.pi) - math.pi))
        la, lb = len(A), len(B)
        while i < la or j < lb:
            a0, a1 = A[i % la], A[(i + 1) % la]
            b0, b1 = B[(j0 + j) % lb], B[(j0 + j + 1) % lb]
            ang = lambda p, base: (p[2] - base) % (2 * math.pi)
            ref = A[0][2]
            adv_a = i < la and (j >= lb or ang(a1, ref) + (2 * math.pi if i + 1 >= la else 0) < ang(b1, ref) + (2 * math.pi if j + 1 >= lb else 0))
            if adv_a: tris.append((a0, a1, b0)); i += 1
            else: tris.append((a0, b0, b1)); j += 1
    # --- shading: light from the top left, a little noise per facet ---
    L = (-0.6, -0.8)
    faces = []
    for t in tris:
        cx = sum(p[0] for p in t) / 3; cy = sum(p[1] for p in t) / 3
        lit = -(cx * L[0] + cy * L[1])            # -1..1
        h, s, l = base
        l2 = l + 0.09 * lit + (rnd.random() - .5) * 0.06
        faces.append(([(p[0], p[1]) for p in t], colorsys.hls_to_rgb(h, max(0, min(1, l2)), s)))
    # --- three arcs (thick top, thin bottom), each a strip of triangles ---
    if bars:
        C = 0.92                       # shared centre below the disc centre
        for rad, half_w, th in ((1.22, 0.60, 0.19), (0.95, 0.47, 0.155), (0.70, 0.35, 0.125)):
            span = math.asin(half_w / rad)
            n = 10
            edge = []
            for i in range(n + 1):
                a = -math.pi / 2 - span + 2 * span * i / n
                edge.append(((rad + th / 2) * math.cos(a), C + (rad + th / 2) * math.sin(a),
                             (rad - th / 2) * math.cos(a), C + (rad - th / 2) * math.sin(a), a))
            def shade(tri, bump):
                cx = sum(p[0] for p in tri) / 3; cy = sum(p[1] for p in tri) / 3
                lit = -(cx * L[0] + cy * L[1])
                l2 = 0.075 + 0.035 * lit + bump + (rnd.random() - .5) * 0.03
                return colorsys.hls_to_rgb(0.4, max(0, l2), 0.08)
            for i in range(n):
                o0, i0, o1, i1 = edge[i][:2], edge[i][2:4], edge[i + 1][:2], edge[i + 1][2:4]
                faces.append(([o0, o1, i0], shade((o0, o1, i0), 0.03)))
                faces.append(([o1, i1, i0], shade((o1, i1, i0), -0.01)))
            # round caps as a fan of 4 triangles around the centreline end
            for e, sgn in ((edge[0], -1), (edge[-1], 1)):
                a = e[4]; cxy = (rad * math.cos(a), C + rad * math.sin(a))
                tang = (-math.sin(a) * sgn, math.cos(a) * sgn)     # direction along the arc, outward
                nrm = (math.cos(a), math.sin(a))
                arc = [(cxy[0] + th / 2 * (nrm[0] * math.cos(b) + tang[0] * math.sin(b)),
                        cxy[1] + th / 2 * (nrm[1] * math.cos(b) + tang[1] * math.sin(b))) for b in [k * math.pi / 4 for k in range(5)]]
                for k in range(4):
                    tri = (cxy, arc[k], arc[k + 1]); faces.append((list(tri), shade(tri, 0.01 * (k % 2))))
    return faces

def hexc(c): return '#%02x%02x%02x' % tuple(round(v * 255) for v in c)

def svg(faces, size=512):
    s = size / 2
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}"><defs><clipPath id="c"><circle cx="{s}" cy="{s}" r="{s}"/></clipPath></defs><g clip-path="url(#c)">']
    for poly, c in faces:
        pts = ' '.join(f'{s + x * s:.1f},{s + y * s:.1f}' for x, y in poly)
        h = hexc(c)
        out.append(f'<polygon points="{pts}" fill="{h}" stroke="{h}" stroke-width="0.8" stroke-linejoin="round"/>')
    out.append('</g></svg>')
    return '\n'.join(out)

def png(faces, size, ss=4):
    S = size * ss; s = S / 2
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    for poly, c in faces:
        col = tuple(round(v * 255) for v in c) + (255,)
        p = [(s + x * s, s + y * s) for x, y in poly]
        d.polygon(p, fill=col, outline=col)
    # circular mask so the rim is a clean circle
    m = Image.new('L', (S, S), 0); ImageDraw.Draw(m).ellipse((0, 0, S - 1, S - 1), fill=255)
    im.putalpha(Image.composite(im.getchannel('A'), m, m))
    return im.resize((size, size), Image.LANCZOS)

if __name__ == '__main__':
    import os
    out = sys.argv[1]
    variants = {
        'a': dict(seed=7),
        'b': dict(seed=21, rings=(1, 6, 11, 16, 21), jitter=0.45),
        'c': dict(seed=3, rings=(1, 8, 15, 22, 29, 36), jitter=0.3),
    }
    sheet = Image.new('RGBA', (3 * 560, 600), (24, 24, 24, 255))
    for i, (k, kw) in enumerate(variants.items()):
        f = build(**kw)
        open(f'{out}/logo-{k}.svg', 'w').write(svg(f))
        im = png(f, 512); im.save(f'{out}/logo-{k}.png')
        sheet.alpha_composite(im, (24 + i * 560, 24))
        for j, sz in enumerate((64, 32, 16)):
            sheet.alpha_composite(png(f, sz), (24 + i * 560 + j * 90, 546 - sz // 2 if sz < 64 else 536 - 20))
    sheet.save(f'{out}/sheet.png')
