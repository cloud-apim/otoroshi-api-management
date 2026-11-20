#!/usr/bin/env python3
# The architecture diagram of the install page, in two variants (light, dark): the same shapes, two
# palettes. Regenerate it after a change: python3 documentation/scripts/architecture.py
from pathlib import Path

W, H = 1200, 760
OUT = Path(__file__).resolve().parent.parent / 'static' / 'img'

PALETTES = {
    'light': dict(text='#1f2328', muted='#57606a', line='#8c959f', card='#ffffff', border='#d0d7de',
                  product='#e8f1fb', product_line='#0b6bcb', chip='#ffffff', pg='#f3f5f8', pg_line='#6e7781',
                  oto='#edf7ef', oto_line='#1a7f37', ext='#fbfbfc', accent='#0b6bcb', path='#bc4c00'),
    'dark': dict(text='#e6edf3', muted='#9da7b3', line='#6e7681', card='#161b22', border='#30363d',
                 product='#0d2136', product_line='#58a6ff', chip='#161b22', pg='#161b22', pg_line='#8b949e',
                 oto='#10231a', oto_line='#3fb950', ext='#11161d', accent='#58a6ff', path='#f0883e'),
}


def svg(p):
    out = []
    a = out.append

    def box(x, y, w, h, fill, stroke, r=12, dash=None, sw=1.5):
        d = f' stroke-dasharray="{dash}"' if dash else ''
        a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def text(x, y, s, size=14, weight=400, color=None, anchor='start', mono=False):
        size += 1  # read at the width of the docs: one point above what the layout was drawn with
        fam = "ui-monospace, SFMono-Regular, Menlo, monospace" if mono else "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
        a(f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{weight}" fill="{color or p["text"]}" text-anchor="{anchor}">{s}</text>')

    def arrow(points, color=None, dash=None, label=None, lx=None, ly=None, anchor='middle', both=False):
        c = color or p['line']
        d = f' stroke-dasharray="{dash}"' if dash else ''
        pts = ' '.join(f'{x},{y}' for x, y in points)
        start = f' marker-start="url(#arrow-start-{c[1:]})"' if both else ''
        a(f'<polyline points="{pts}" fill="none" stroke="{c}" stroke-width="1.6"{d} marker-end="url(#arrow-{c[1:]})"{start}/>')
        if label:
            text(lx, ly, label, size=12, color=p['muted'], anchor=anchor)

    def cylinder(x, y, w, h, title, sub):
        e = 9
        a(f'<path d="M{x},{y + e} a{w / 2},{e} 0 0,1 {w},0 v{h - 2 * e} a{w / 2},{e} 0 0,1 -{w},0 z" fill="{p["card"]}" stroke="{p["pg_line"]}" stroke-width="1.4"/>')
        a(f'<path d="M{x},{y + e} a{w / 2},{e} 0 0,0 {w},0" fill="none" stroke="{p["pg_line"]}" stroke-width="1.4"/>')
        text(x + w / 2, y + h / 2 - 4, title, size=14, weight=600, anchor='middle', mono=True)
        text(x + w / 2, y + h / 2 + 16, sub, size=12, color=p['muted'], anchor='middle')

    colors = {p['line'], p['accent'], p['path'], p['oto_line'], p['muted']}
    a(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="The architecture of an installation">')
    a('<defs>')
    for c in colors:
        a(f'<marker id="arrow-{c[1:]}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>')
        a(f'<marker id="arrow-start-{c[1:]}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>')
    a('</defs>')

    # ---------------------------------------------------------------- who uses it
    actors = [
        (60, 'Administrators, producers', 'a browser'),
        (160, 'Consumers', 'a browser'),
        (260, 'CI, scripts', 'the cli, the admin api'),
        (360, 'Kubernetes', 'resources (optional)'),
    ]
    for y, t, s in actors:
        box(30, y, 220, 64, p['card'], p['border'])
        text(46, y + 28, t, size=14, weight=600)
        text(46, y + 48, s, size=12, color=p['muted'])

    # ---------------------------------------------------------------- the product
    box(330, 40, 430, 410, p['product'], p['product_line'], r=16, sw=2)
    text(352, 72, 'otoroshi-api-management', size=17, weight=700, mono=True)
    text(352, 94, 'one executable or one image · stateless · N instances', size=12, color=p['muted'])
    roles = [
        (125, 'backoffice', '/backoffice — the console'),
        (195, 'portal', '/&lt;workspace&gt;/ — the developer portals'),
        (265, 'api', '/api — the admin api'),
        (335, 'ingester', '/ingest — the events of the gateway'),
    ]
    for y, r, s in roles:
        box(352, y, 386, 54, p['chip'], p['border'], r=10)
        text(370, y + 23, r, size=14, weight=600, mono=True)
        text(370, y + 42, s, size=12, color=p['muted'])
    box(352, 400, 386, 36, p['chip'], p['border'], r=10, dash='5 4')
    text(370, 423, 'controller', size=13, weight=600, mono=True)
    text(470, 423, 'the Kubernetes resources — optional', size=12, color=p['muted'])

    arrow([(250, 92), (352, 152)], color=p['accent'])
    arrow([(250, 192), (352, 222)], color=p['accent'])
    arrow([(250, 292), (352, 292)], color=p['accent'])
    arrow([(250, 392), (352, 418)], color=p['accent'], dash='5 4')

    # ---------------------------------------------------------------- the databases
    box(330, 500, 430, 230, p['pg'], p['pg_line'], r=16)
    text(352, 532, 'PostgreSQL 14 or later', size=16, weight=700)
    text(352, 552, 'two databases, two urls — one server is enough', size=12, color=p['muted'])
    cylinder(355, 575, 185, 132, 'apim', 'workspaces, apis, plans,')
    text(447, 682, 'subscriptions, audit', size=12, color=p['muted'], anchor='middle')
    cylinder(552, 575, 185, 132, 'apim_analytics', 'the calls, their rollups,')
    text(644, 682, 'the security events', size=12, color=p['muted'], anchor='middle')
    arrow([(545, 450), (545, 500)], label='SQL', lx=557, ly=480, anchor='start', both=True)

    # ---------------------------------------------------------------- the gateway
    box(870, 40, 300, 350, p['oto'], p['oto_line'], r=16, sw=2)
    text(892, 72, 'Otoroshi 18.1 cluster', size=17, weight=700)
    text(892, 94, 'leader and workers, its own datastore', size=12, color=p['muted'])
    box(892, 115, 256, 54, p['card'], p['border'], r=10)
    text(908, 138, 'admin api', size=14, weight=600)
    text(908, 157, 'an admin key with every right', size=12, color=p['muted'])
    box(892, 185, 256, 54, p['card'], p['border'], r=10)
    text(908, 208, 'data exporter', size=14, weight=600)
    text(908, 227, 'apim_ingester_exporter', size=12, color=p['muted'], mono=True)
    box(892, 255, 256, 112, p['card'], p['oto_line'], r=10)
    text(908, 280, 'gateway — the data plane', size=14, weight=600)
    text(908, 300, 'the routes and plans of the apis,', size=12, color=p['muted'])
    text(908, 318, 'the keys of the subscriptions,', size=12, color=p['muted'])
    text(908, 336, 'quotas, auth. modules, verifiers', size=12, color=p['muted'])
    text(908, 354, '(extensions: threat protection, llm)', size=12, color=p['muted'])

    arrow([(738, 292), (838, 292), (838, 142), (892, 142)], color=p['accent'])
    text(800, 205, 'projection,', size=12, color=p['muted'], anchor='middle')
    text(800, 221, 'drift, setup', size=12, color=p['muted'], anchor='middle')
    arrow([(892, 212), (856, 212), (856, 362), (738, 362)], color=p['oto_line'])
    text(800, 322, 'events,', size=12, color=p['muted'], anchor='middle')
    text(800, 338, 'in batches', size=12, color=p['muted'], anchor='middle')

    # ---------------------------------------------------------------- the request path
    box(870, 470, 140, 64, p['card'], p['border'])
    text(884, 498, 'Client apps', size=14, weight=600)
    text(884, 518, 'of the consumers', size=12, color=p['muted'])
    box(1030, 470, 140, 64, p['card'], p['border'])
    text(1044, 498, 'Backends', size=14, weight=600)
    text(1044, 518, 'behind the apis', size=12, color=p['muted'])
    arrow([(940, 470), (940, 367)], color=p['path'])
    arrow([(1100, 367), (1100, 470)], color=p['path'])
    text(1020, 566, 'the request path:', size=12, weight=600, color=p['path'], anchor='middle')
    text(1020, 584, 'client → gateway → backend,', size=12, color=p['path'], anchor='middle')
    text(1020, 602, 'the product never in it', size=12, color=p['path'], anchor='middle')

    # ---------------------------------------------------------------- what it may use
    box(30, 478, 220, 262, p['ext'], p['border'], r=14, dash='5 4')
    text(46, 504, 'What it may use', size=13, weight=700, color=p['muted'])
    ext = [(520, 'an OIDC provider', 'sign in, console and portals'), (590, 'Stripe', 'the paid plans (Connect)'), (660, 'git · S3 · HTTP', 'the remote catalogs')]
    for y, t, s_ in ext:
        box(44, y, 192, 58, p['card'], p['border'], r=10)
        text(58, y + 25, t, size=13, weight=600)
        text(58, y + 43, s_, size=11, color=p['muted'])
    arrow([(345, 450), (250, 500)], dash='5 4')
    a('</svg>')
    return '\n'.join(out)


for name, palette in PALETTES.items():
    (OUT / f'architecture-{name}.svg').write_text(svg(palette))
    print(OUT / f'architecture-{name}.svg')
