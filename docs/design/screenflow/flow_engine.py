# -*- coding: utf-8 -*-
"""Engine for FITLY screen-flow diagrams: grid layout, orthogonal A* edge routing, geometry validator,
PNG renderer (Pillow) and draw.io writer.  Used by gen_screenflow_drawio.py (which only holds the diagram data).

Conventions (UML-ish screen flow):
  screen   = rounded box (name + route)          modal  = dashed purple box (dialog / drawer / sheet)
  external = red box (outside system)            ref    = grey dashed box "see another diagram"
  menu     = tall blue bar (sidebar / header menu that fans out to several screens)
  start    = filled circle, decision = diamond
  arrows   = navigation, short label = user action; dashed arrow = automatic redirect / guard.
All lines are orthogonal polylines found by A*; the validator proves they never cross a screen box.
"""
import html, math, heapq, itertools
from PIL import Image, ImageDraw, ImageFont

BW, BH = 160, 48          # screen box
PX, PY = 240, 120          # grid pitch (gap 48)
G = 8                     # routing lattice
MARGIN_L, MARGIN_T = 40, 104
CLEAR = 12                # min distance of a line from any box (lattice points closer are blocked)
STUB = 16
SCALE = 2                 # PNG scale  (logical 13px -> 26px)

FW = r'C:\Windows\Fonts\arial.ttf'
FB = r'C:\Windows\Fonts\arialbd.ttf'
def font(sz, bold=False): return ImageFont.truetype(FB if bold else FW, int(round(sz * SCALE)))
F_NAME, F_ROUTE, F_LABEL, F_GROUP = 13, 11, 11, 14

TYPES = {  # fill, border, text colour, dashed
    'screen':   ((255, 255, 255), (51, 51, 51), (0, 0, 0), False, 'fillColor=#FFFFFF;strokeColor=#333333;'),
    'home':     ((255, 242, 204), (214, 182, 86), (0, 0, 0), False, 'fillColor=#FFF2CC;strokeColor=#D6B656;'),
    'modal':    ((245, 238, 248), (150, 115, 166), (0, 0, 0), True, 'fillColor=#F5EEF8;strokeColor=#9673A6;dashed=1;'),
    'external': ((248, 206, 204), (184, 84, 80), (0, 0, 0), False, 'fillColor=#F8CECC;strokeColor=#B85450;'),
    'ref':      ((238, 238, 238), (120, 120, 120), (60, 60, 60), True, 'fillColor=#EEEEEE;strokeColor=#787878;dashed=1;'),
    'menu':     ((218, 232, 252), (108, 142, 191), (0, 0, 0), False, 'fillColor=#DAE8FC;strokeColor=#6C8EBF;'),
    'admin':    ((213, 232, 212), (130, 179, 102), (0, 0, 0), False, 'fillColor=#D5E8D4;strokeColor=#82B366;'),
}


class N:  # node
    def __init__(s, id, name, route, kind, c, r, rows=1):
        s.id, s.name, s.route, s.kind, s.c, s.r, s.rows = id, name, route, kind, c, r, rows
        if kind in ('start', 'decision', 'end'):
            s.w, s.h = (32, 32) if kind != 'decision' else (144, 64)
        else:
            s.w, s.h = BW, BH + (rows - 1) * PY
        s.x = MARGIN_L + int(round(c * PX))
        full_h = BH + (rows - 1) * PY
        s.y = MARGIN_T + int(round(r * PY))
        # centre small shapes inside their grid cell
        s.x += (BW - s.w) // 2
        s.y += (full_h - s.h) // 2
    @property
    def rect(s): return (s.x, s.y, s.x + s.w, s.y + s.h)
    @property
    def cx(s): return s.x + s.w / 2
    @property
    def cy(s): return s.y + s.h / 2


class Diagram:
    def __init__(self, slug, title, caption, nodes, edges, groups=(), legend=True, note=None):
        self.slug, self.title, self.caption = slug, title, caption
        self.nodes = {}
        for t in nodes:
            n = N(*t) if not isinstance(t, N) else t
            assert n.id not in self.nodes, n.id
            self.nodes[n.id] = n
        self.edges = [dict(a=e[0], b=e[1], label=e[2] if len(e) > 2 else '', dash=(len(e) > 3 and 'd' in e[3]),
                           sides=(e[3].replace('d', '') if len(e) > 3 and len(e[3].replace('d', '')) == 2 else None)) for e in edges]
        self.groups = [dict(title=g[0], ids=list(g[1])) for g in groups]
        self.legend = legend
        self.note = note
        self.errors, self.warns = [], []

    # ------------------------------------------------------------------ geometry helpers
    def grect(self, g):
        xs0, ys0, xs1, ys1 = [], [], [], []
        for i in g['ids']:
            r = self.nodes[i].rect
            xs0.append(r[0]); ys0.append(r[1]); xs1.append(r[2]); ys1.append(r[3])
        pad = 16
        return (min(xs0) - pad, min(ys0) - pad - 32, max(xs1) + pad, max(ys1) + pad)

    def canvas(self):
        xs, ys = [0], [0]
        for n in self.nodes.values(): xs.append(n.rect[2]); ys.append(n.rect[3])
        for g in self.groups: r = self.grect(g); xs.append(r[2]); ys.append(r[3])
        W = int(max(xs) + 48); H = int(max(ys) + 56)
        if self.legend: H += 64
        W = (W + 7) // 8 * 8; H = (H + 7) // 8 * 8
        return W, H

    # ------------------------------------------------------------------ routing
    def port_xy(self, n, side, coord):
        x0, y0, x1, y1 = n.rect
        if n.kind == 'decision':
            # diamond: ports at the vertices
            return {'l': (x0, n.cy), 'r': (x1, n.cy), 't': (n.cx, y0), 'b': (n.cx, y1)}[side]
        if side == 'l': return (x0, coord)
        if side == 'r': return (x1, coord)
        if side == 't': return (coord, y0)
        return (coord, y1)

    def coord_range(self, n, side):
        x0, y0, x1, y1 = n.rect
        if n.kind in ('start', 'end', 'decision'):
            c = n.cy if side in 'lr' else n.cx
            return (c, c)
        if side in 'lr': return (y0 + 8, y1 - 8)
        return (x0 + 16, x1 - 16)

    def run(self):
        W, H = self.canvas(); self.W, self.H = W, H
        self.legend_rect = (MARGIN_L - 8, H - 56, MARGIN_L + 1040, H - 8) if self.legend else None
        blocked = set()
        self.blocked_rects = []
        for n in self.nodes.values():
            x0, y0, x1, y1 = n.rect
            self.blocked_rects.append((x0 - CLEAR, y0 - CLEAR, x1 + CLEAR, y1 + CLEAR))
        if self.legend_rect:
            lx0, ly0, lx1, ly1 = self.legend_rect
            self.blocked_rects.append((lx0, ly0 - 4, lx1, ly1 + 4))
        for (x0, y0, x1, y1) in self.blocked_rects:
            for gx in range(int(x0 // G), int(x1 // G) + 2):
                if not (x0 < gx * G < x1): continue
                for gy in range(int(y0 // G), int(y1 // G) + 2):
                    if y0 < gy * G < y1: blocked.add((gx, gy))
        self.blocked = blocked
        # group title zones: lines may not run through them -> block as well (thin)
        for g in self.groups:
            gx0, gy0, gx1, gy1 = self.grect(g)
            tw = ImageFont.truetype(FB, F_GROUP).getlength(g['title']) + 20
            for gx in range(int(gx0 // G), int((gx0 + tw) // G) + 1):
                for gy in range(int(gy0 // G), int((gy0 + 16) // G) + 1):
                    blocked.add((gx, gy))
        # 1) choose sides
        for e in self.edges:
            a, b = self.nodes[e['a']], self.nodes[e['b']]
            if e['sides']:
                e['sa'], e['sb'] = e['sides'][0], e['sides'][1]
            else:
                e['sa'], e['sb'] = self.pick_sides(e, a, b)
        # 2) port coordinates
        self.assign_ports()
        # 3) route short edges first
        used = {}
        order = sorted(range(len(self.edges)), key=lambda i: self.est_len(self.edges[i]))
        for i in order:
            e = self.edges[i]
            path = self.route(e, used)
            if path is None:
                self.errors.append(f'no route {e["a"]}->{e["b"]}')
                path = [e['pa'], e['pb']]
            e['path'] = path
            for p, q in zip(path, path[1:]):
                self.mark(used, p, q)
        # 4) labels
        self.place_labels()

    def est_len(self, e):
        a, b = self.nodes[e['a']], self.nodes[e['b']]
        return abs(a.cx - b.cx) + abs(a.cy - b.cy)

    def mark(self, used, p, q):
        if p[0] == q[0]:
            o = 'v'; y0, y1 = sorted((p[1], q[1]))
            for y in range(int(y0), int(y1) + 1, G): used[((int(p[0]) // G, y // G), o)] = 1
        else:
            o = 'h'; x0, x1 = sorted((p[0], q[0]))
            for x in range(int(x0), int(x1) + 1, G): used[((x // G, int(p[1]) // G), o)] = 1

    def aligned_coord(self, a, b, side):
        """if a and b can be joined by a straight line (side l/r: same y; t/b: same x) return that coordinate"""
        if side in 'lr':
            lo = max(self.coord_range(a, side)[0], self.coord_range(b, 'l' if side == 'r' else 'r')[0])
            hi = min(self.coord_range(a, side)[1], self.coord_range(b, 'l' if side == 'r' else 'r')[1])
            if lo <= hi:
                # prefer centre of the smaller node
                tgt = (a.cy if a.h <= b.h else b.cy)
                v = min(max(tgt, lo), hi)
                return int(round(v / 8) * 8) if lo != hi else lo
        else:
            lo = max(self.coord_range(a, side)[0], self.coord_range(b, 'b' if side == 't' else 't')[0])
            hi = min(self.coord_range(a, side)[1], self.coord_range(b, 'b' if side == 't' else 't')[1])
            if lo <= hi:
                tgt = (a.cx if a.w <= b.w else b.cx)
                v = min(max(tgt, lo), hi)
                return int(round(v / 8) * 8) if lo != hi else lo
        return None

    def pick_sides(self, e, a, b):
        dx, dy = b.cx - a.cx, b.cy - a.cy
        # straight horizontal
        if self.aligned_coord(a, b, 'r' if dx > 0 else 'l') is not None and abs(dx) >= abs(dy) * 0.0 and \
           (b.rect[0] >= a.rect[2] if dx > 0 else b.rect[2] <= a.rect[0]):
            return ('r', 'l') if dx > 0 else ('l', 'r')
        if self.aligned_coord(a, b, 'b' if dy > 0 else 't') is not None and \
           (b.rect[1] >= a.rect[3] if dy > 0 else b.rect[3] <= a.rect[1]):
            return ('b', 't') if dy > 0 else ('t', 'b')
        # try candidates by A* cost with centred ports
        sa_h = 'r' if dx > 0 else 'l'; sa_v = 'b' if dy > 0 else 't'
        sb_h = 'l' if dx > 0 else 'r'; sb_v = 't' if dy > 0 else 'b'
        best = None
        for sa in (sa_h, sa_v):
            for sb in (sb_h, sb_v):
                pa = self.port_xy(a, sa, a.cy if sa in 'lr' else a.cx)
                pb = self.port_xy(b, sb, b.cy if sb in 'lr' else b.cx)
                r = self.astar(pa, sa, pb, sb, {}, probe=True)
                if r is None: continue
                cost = r[1] + (0 if sa == sa_h else 2)  # prefer leaving horizontally
                if best is None or cost < best[0]: best = (cost, sa, sb)
        if best is None: return (sa_h, sb_h)
        return best[1], best[2]

    def assign_ports(self):
        slots = {}
        for i, e in enumerate(self.edges):
            slots.setdefault((e['a'], e['sa']), []).append((i, 'a'))
            slots.setdefault((e['b'], e['sb']), []).append((i, 'b'))
        for (nid, side), lst in slots.items():
            n = self.nodes[nid]; lo, hi = self.coord_range(n, side)
            spacing = 16 if side in 'lr' else 24
            def other(i, end):
                e = self.edges[i]; o = self.nodes[e['b' if end == 'a' else 'a']]
                return o.cy if side in 'lr' else o.cx
            fixed = {}
            for i, end in lst:
                e = self.edges[i]
                oth = self.nodes[e['b' if end == 'a' else 'a']]
                ac = self.aligned_coord(n, oth, side) if end == 'a' or True else None
                # aligned only when the facing sides match a straight line
                osd = e['sb' if end == 'a' else 'sa']
                facing = {'r': 'l', 'l': 'r', 't': 'b', 'b': 't'}[side]
                if ac is not None and osd == facing:
                    fixed[(i, end)] = ac
            coords = {}
            taken = []
            for k, v in fixed.items():
                if all(abs(v - t) >= spacing for t in taken): coords[k] = v; taken.append(v)
            rest = [(i, end) for (i, end) in lst if (i, end) not in coords]
            rest.sort(key=lambda t: other(*t))
            if rest:
                mid = (lo + hi) / 2
                cand = []
                v = lo
                while v <= hi + 1e-6: cand.append(int(round(v / 8) * 8)); v += 8
                cand = sorted(set(cand), key=lambda c: abs(c - round(mid / 8) * 8))
                free = [c for c in cand if all(abs(c - t) >= spacing for t in taken)]
                if len(free) < len(rest):  # relax
                    free = [c for c in cand if all(abs(c - t) >= 8 for t in taken)]
                chosen = sorted(free[:len(rest)])
                if len(chosen) < len(rest): chosen = (chosen + [int(mid)] * len(rest))[:len(rest)]
                for (i, end), c in zip(rest, chosen): coords[(i, end)] = c
            for (i, end), c in coords.items():
                e = self.edges[i]
                e['pa' if end == 'a' else 'pb'] = self.port_xy(n, side, c)
        for e in self.edges:
            for k in ('pa', 'pb'): e[k] = (int(e[k][0]), int(e[k][1]))

    DIRS = {'r': (1, 0), 'l': (-1, 0), 't': (0, -1), 'b': (0, 1)}

    def astar(self, pa, sa, pb, sb, used, probe=False):
        d0 = self.DIRS[sa]
        s = (pa[0] + d0[0] * STUB, pa[1] + d0[1] * STUB)
        d1 = self.DIRS[sb]
        t = (pb[0] + d1[0] * STUB, pb[1] + d1[1] * STUB)
        inward = (-d1[0], -d1[1])
        W, H = self.W // G, self.H // G
        sg = (s[0] // G, s[1] // G); tg = (t[0] // G, t[1] // G)
        if s[0] % G or s[1] % G or t[0] % G or t[1] % G: return None
        start = (sg[0], sg[1], d0)
        heap = [(0, 0, start)]
        best = {start: 0}
        prev = {}
        BEND = 6
        cnt = itertools.count()
        while heap:
            f, g, st = heapq.heappop(heap)
            if best.get(st, 1e18) < g: continue
            x, y, d = st
            if (x, y) == tg and d == inward:
                # reconstruct
                pts = [(x, y)]
                cur = st
                while cur in prev:
                    cur = prev[cur]; pts.append((cur[0], cur[1]))
                pts.reverse()
                poly = [pa] + [(p[0] * G, p[1] * G) for p in pts] + [pb]
                return (self.simplify(poly), g)
            for nd in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                if nd == (-d[0], -d[1]): continue
                nx, ny = x + nd[0], y + nd[1]
                if not (0 <= nx < W and 0 <= ny < H): continue
                if (nx, ny) in self.blocked and (nx, ny) != tg and (nx, ny) != sg: continue
                cost = 1 + (BEND if nd != d else 0)
                if not probe:
                    o = 'h' if nd[0] else 'v'
                    if used.get(((nx, ny), o)): cost += 9
                    elif used.get(((nx, ny), 'v' if o == 'h' else 'h')): cost += 2
                ng = g + cost
                ns = (nx, ny, nd)
                if ng < best.get(ns, 1e18):
                    best[ns] = ng; prev[ns] = st
                    h = abs(nx - tg[0]) + abs(ny - tg[1])
                    heapq.heappush(heap, (ng + h, ng, ns))
        return None

    @staticmethod
    def simplify(poly):
        out = [poly[0]]
        for p in poly[1:]:
            if p == out[-1]: continue
            out.append(p)
        res = [out[0]]
        for i in range(1, len(out) - 1):
            a, b, c = res[-1], out[i], out[i + 1]
            if (a[0] == b[0] == c[0]) or (a[1] == b[1] == c[1]): continue
            res.append(b)
        res.append(out[-1])
        return res

    def route(self, e, used):
        a, b = self.nodes[e['a']], self.nodes[e['b']]
        r = self.astar(e['pa'], e['sa'], e['pb'], e['sb'], used)
        return r[0] if r else None

    # ------------------------------------------------------------------ labels
    def label_size(self, text):
        f = ImageFont.truetype(FW, F_LABEL)
        return int(f.getlength(text)) + 8, 16

    def place_labels(self):
        self.label_rects = []
        occupied = []
        for e in sorted(self.edges, key=lambda e: len(e['label']) * -1):
            e['lrect'] = None
            if not e['label']: continue
            w, h = self.label_size(e['label'])
            path = e['path']
            segs = []
            for p, q in zip(path, path[1:]):
                L = abs(p[0] - q[0]) + abs(p[1] - q[1])
                segs.append((L, p, q))
            cands = []
            for L, p, q in sorted(segs, key=lambda s: -s[0]):
                horiz = p[1] == q[1]
                need = (w + 14) if horiz else (h + 14)
                for t in (0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8):
                    if L < need * 0.6 and t != 0.5: continue
                    mx = p[0] + (q[0] - p[0]) * t; my = p[1] + (q[1] - p[1]) * t
                    cands.append((L >= need, (mx - w / 2, my - h / 2, mx + w / 2, my + h / 2), p, q, L))
            cands.sort(key=lambda c: not c[0])
            chosen = None
            for ok, r, p, q, L in cands:
                if self.label_ok(r, e, occupied, strict=True): chosen = r; break
            if chosen is None:
                for ok, r, p, q, L in cands:
                    if self.label_ok(r, e, occupied, strict=False): chosen = r; self.warns.append(f'label crosses a line: {e["label"]}'); break
            if chosen is None:
                self.errors.append(f'label cannot be placed: {e["a"]}->{e["b"]} "{e["label"]}"')
                chosen = cands[0][1] if cands else (0, 0, w, h)
            e['lrect'] = chosen; occupied.append(chosen)

    def label_ok(self, r, e, occupied, strict):
        infl = 3
        for n in self.nodes.values():
            x0, y0, x1, y1 = n.rect
            if r[0] < x1 + infl and r[2] > x0 - infl and r[1] < y1 + infl and r[3] > y0 - infl: return False
        for o in occupied:
            if r[0] < o[2] + 4 and r[2] > o[0] - 4 and r[1] < o[3] + 3 and r[3] > o[1] - 3: return False
        if self.legend_rect:
            l = self.legend_rect
            if r[0] < l[2] and r[2] > l[0] and r[1] < l[3] and r[3] > l[1]: return False
        for g in self.groups:
            gx0, gy0, gx1, gy1 = self.grect(g)
            tw = ImageFont.truetype(FB, F_GROUP).getlength(g['title']) + 16
            if r[0] < gx0 + tw and r[2] > gx0 and r[1] < gy0 + 24 and r[3] > gy0: return False
        if r[0] < 4 or r[1] < 4 or r[2] > self.W - 4 or r[3] > self.H - 4: return False
        if strict:
            for o in self.edges:
                if o is e or 'path' not in o: continue
                for p, q in zip(o['path'], o['path'][1:]):
                    if seg_rect(p, q, (r[0] - 2, r[1] - 2, r[2] + 2, r[3] + 2)): return False
        # label must not sit on the arrow tip of its own edge
        pb = e['path'][-1]
        if r[0] - 6 < pb[0] < r[2] + 6 and r[1] - 6 < pb[1] < r[3] + 6: return False
        pa = e['path'][0]
        if r[0] - 4 < pa[0] < r[2] + 4 and r[1] - 4 < pa[1] < r[3] + 4: return False
        return True

    # ------------------------------------------------------------------ validator
    def validate(self):
        err, warn = self.errors, self.warns
        ns = list(self.nodes.values())
        # text fit
        fn, fr = ImageFont.truetype(FB, F_NAME), ImageFont.truetype(FW, F_ROUTE)
        for n in ns:
            if n.kind in ('start', 'end'): continue
            if n.kind == 'decision':
                if fn.getlength(n.name) > n.w - 36 and '\n' not in n.name: err.append(f'decision text too long: {n.name}')
                continue
            for part, f in ((n.name, fn), (n.route, fr)):
                for ln in part.split('\n'):
                    if f.getlength(ln) > n.w - 14: err.append(f'text overflow in {n.id}: {ln} ({f.getlength(ln):.0f}>{n.w - 14})')
        # node overlap / gaps
        for a, b in itertools.combinations(ns, 2):
            ra, rb = a.rect, b.rect
            if ra[0] < rb[2] + 24 and ra[2] > rb[0] - 24 and ra[1] < rb[3] + 24 and ra[3] > rb[1] - 24:
                err.append(f'boxes too close/overlap: {a.id} {b.id}')
        # groups contain only own nodes, groups disjoint
        gr = [(g, self.grect(g)) for g in self.groups]
        for g, r in gr:
            for n in ns:
                if n.id in g['ids']: continue
                x0, y0, x1, y1 = n.rect
                if x0 < r[2] and x1 > r[0] and y0 < r[3] and y1 > r[1]: err.append(f'group "{g["title"]}" overlaps node {n.id}')
        for (g1, r1), (g2, r2) in itertools.combinations(gr, 2):
            if r1[0] < r2[2] + 4 and r1[2] > r2[0] - 4 and r1[1] < r2[3] + 4 and r1[3] > r2[1] - 4:
                err.append(f'groups overlap: {g1["title"]} / {g2["title"]}')
        # edges vs boxes (strict: segment must not touch the interior)
        for e in self.edges:
            path = e['path']
            for p, q in zip(path, path[1:]):
                if p[0] != q[0] and p[1] != q[1]: err.append(f'diagonal segment {e["a"]}->{e["b"]}')
                for n in ns:
                    x0, y0, x1, y1 = n.rect
                    if n.kind == 'decision':
                        if seg_diamond(p, q, n): err.append(f'edge {e["a"]}->{e["b"]} crosses {n.id}')
                        continue
                    if seg_rect(p, q, (x0 + 1, y0 + 1, x1 - 1, y1 - 1)): err.append(f'edge {e["a"]}->{e["b"]} crosses box {n.id}')
            # edge endpoints on the right boxes
            if not path or len(path) < 2: err.append(f'empty path {e["a"]}->{e["b"]}')
            # keep a minimum visible final segment for the arrowhead
            pl = path[-2:]
            if abs(pl[0][0] - pl[1][0]) + abs(pl[0][1] - pl[1][1]) < 14: err.append(f'final segment too short {e["a"]}->{e["b"]}')
            # edge through group title
            for g, r in gr:
                tw = ImageFont.truetype(FB, F_GROUP).getlength(g['title']) + 16
                tr = (r[0], r[1], r[0] + tw, r[1] + 20)
                for p, q in zip(path, path[1:]):
                    if seg_rect(p, q, tr): err.append(f'edge {e["a"]}->{e["b"]} crosses title of group {g["title"]}')
        # collinear overlaps between different edges
        for e1, e2 in itertools.combinations(self.edges, 2):
            tot = 0
            for p, q in zip(e1['path'], e1['path'][1:]):
                for r, s in zip(e2['path'], e2['path'][1:]):
                    tot += collinear_overlap(p, q, r, s)
            if tot > 10 and e1['a'] != e2['a'] and e1['b'] != e2['b']:
                err.append(f'edges overlap: {e1["a"]}->{e1["b"]} / {e2["a"]}->{e2["b"]} ({tot}px)')
            elif tot > 24:
                warn.append(f'shared trunk {e1["a"]}->{e1["b"]} / {e2["a"]}->{e2["b"]} ({tot}px)')
        # crossings (warn)
        cross = 0
        for e1, e2 in itertools.combinations(self.edges, 2):
            for p, q in zip(e1['path'], e1['path'][1:]):
                for r, s in zip(e2['path'], e2['path'][1:]):
                    if proper_cross(p, q, r, s): cross += 1
        self.crossings = cross
        # label vs label / label vs box done in placement; recheck
        for e in self.edges:
            if not e.get('lrect'): continue
            r = e['lrect']
            for n in ns:
                x0, y0, x1, y1 = n.rect
                if r[0] < x1 and r[2] > x0 and r[1] < y1 and r[3] > y0: err.append(f'label over box: {e["label"]} / {n.id}')
        return err

    # ------------------------------------------------------------------ PNG
    def png(self, path):
        S = SCALE; W, H = self.W, self.H
        img = Image.new('RGB', (W * S, H * S), 'white'); dr = ImageDraw.Draw(img)
        fN, fR, fL, fG = font(F_NAME, True), font(F_ROUTE), font(F_LABEL), font(F_GROUP, True)
        def sc(p): return (p[0] * S, p[1] * S)
        # title
        dr.text((MARGIN_L * S, 14 * S), self.title, fill=(30, 30, 30), font=font(18, True))
        # groups
        for g in self.groups:
            r = self.grect(g)
            dr.rounded_rectangle([r[0] * S, r[1] * S, r[2] * S, r[3] * S], radius=10 * S, outline=(150, 150, 150), fill=(247, 248, 250), width=S)
            dr.text(((r[0] + 10) * S, (r[1] + 4) * S), g['title'], fill=(70, 70, 70), font=fG)
        # edges
        for e in self.edges:
            pts = [sc(p) for p in e['path']]
            col = (68, 68, 68)
            for p, q in zip(pts, pts[1:]):
                if e['dash']: dash_line(dr, p, q, col, 1.6 * S, 6 * S, 4 * S)
                else: dr.line([p, q], fill=col, width=int(1.6 * S))
            arrow(dr, pts[-2], pts[-1], col, S)
        # nodes
        for n in self.nodes.values():
            x0, y0, x1, y1 = [v * S for v in n.rect]
            if n.kind == 'start':
                dr.ellipse([x0, y0, x1, y1], fill=(30, 30, 30))
                if n.name:
                    tw = font(F_ROUTE, True).getlength(n.name)
                    dr.text(((x0 + x1) / 2 - tw / 2, y1 + 3 * S), n.name, fill=(30, 30, 30), font=font(F_ROUTE, True))
                continue
            if n.kind == 'end':
                dr.ellipse([x0, y0, x1, y1], outline=(30, 30, 30), width=2 * S, fill='white')
                dr.ellipse([x0 + 7 * S, y0 + 7 * S, x1 - 7 * S, y1 - 7 * S], fill=(30, 30, 30))
                continue
            if n.kind == 'decision':
                dr.polygon([((x0 + x1) / 2, y0), (x1, (y0 + y1) / 2), ((x0 + x1) / 2, y1), (x0, (y0 + y1) / 2)], fill=(255, 250, 225), outline=(214, 182, 86))
                lines = n.name.split('\n'); lh = F_NAME * S * 1.15
                ty = (y0 + y1) / 2 - lh * len(lines) / 2
                f = font(F_ROUTE + 1, True)
                for ln in lines:
                    dr.text(((x0 + x1) / 2 - f.getlength(ln) / 2, ty), ln, fill=(0, 0, 0), font=f); ty += lh
                continue
            fill, border, tc, dashed_, _ = TYPES[n.kind]
            if dashed_:
                dr.rounded_rectangle([x0, y0, x1, y1], radius=8 * S, fill=fill)
                dash_rect(dr, (x0, y0, x1, y1), border, S)
            else:
                dr.rounded_rectangle([x0, y0, x1, y1], radius=8 * S, fill=fill, outline=border, width=int(1.5 * S))
            nl, rl = n.name.split('\n'), n.route.split('\n') if n.route else []
            hN, hR = F_NAME * 1.2 * S, F_ROUTE * 1.2 * S
            tot = hN * len(nl) + hR * len(rl)
            ty = (y0 + y1) / 2 - tot / 2
            for ln in nl:
                dr.text(((x0 + x1) / 2 - fN.getlength(ln) / 2, ty), ln, fill=tc, font=fN); ty += hN
            for ln in rl:
                dr.text(((x0 + x1) / 2 - fR.getlength(ln) / 2, ty), ln, fill=(95, 95, 95), font=fR); ty += hR
        # labels
        for e in self.edges:
            r = e.get('lrect')
            if not r: continue
            dr.rectangle([r[0] * S, r[1] * S, r[2] * S, r[3] * S], fill='white')
            dr.text(((r[0] + 4) * S, (r[1] + 1) * S), e['label'], fill=(20, 20, 20), font=fL)
        if self.legend: self.draw_legend(dr)
        img.save(path, optimize=True)

    def draw_legend(self, dr):
        S = SCALE; x = self.legend_rect[0] + 8; y = self.legend_rect[1] + 8
        f = font(F_ROUTE)
        items = [('screen', 'Screen (name, route)'), ('modal', 'Dialog / drawer / sheet'), ('ref', 'Screen in another diagram'),
                 ('external', 'External system'), ('menu', 'Menu / tab bar')]
        for kind, text in items:
            fill, border, _, dashed_, _ = TYPES[kind]
            box = (x * S, y * S, (x + 22) * S, (y + 14) * S)
            dr.rounded_rectangle(box, radius=3 * S, fill=fill)
            if dashed_: dash_rect(dr, box, border, S)
            else: dr.rounded_rectangle(box, radius=3 * S, outline=border, width=S, fill=fill)
            dr.text(((x + 28) * S, (y - 1) * S), text, fill=(40, 40, 40), font=f)
            x += 28 + int(ImageFont.truetype(FW, F_ROUTE).getlength(text)) + 18
        y2 = y + 22; x2 = self.legend_rect[0] + 8
        dr.line([x2 * S, (y2 + 6) * S, (x2 + 30) * S, (y2 + 6) * S], fill=(68, 68, 68), width=int(1.6 * S)); arrow(dr, ((x2 + 20) * S, (y2 + 6) * S), ((x2 + 30) * S, (y2 + 6) * S), (68, 68, 68), S)
        dr.text(((x2 + 38) * S, y2 * S), 'User navigation (label = action)', fill=(40, 40, 40), font=f)
        x3 = x2 + 38 + int(ImageFont.truetype(FW, F_ROUTE).getlength('User navigation (label = action)')) + 24
        dash_line(dr, (x3 * S, (y2 + 6) * S), ((x3 + 30) * S, (y2 + 6) * S), (68, 68, 68), 1.6 * S, 6 * S, 4 * S); arrow(dr, ((x3 + 20) * S, (y2 + 6) * S), ((x3 + 30) * S, (y2 + 6) * S), (68, 68, 68), S)
        dr.text(((x3 + 38) * S, y2 * S), 'Automatic redirect / guard', fill=(40, 40, 40), font=f)
        if self.note:
            x4 = x3 + 38 + int(ImageFont.truetype(FW, F_ROUTE).getlength('Automatic redirect / guard')) + 24
            dr.text((x4 * S, y2 * S), self.note, fill=(90, 90, 90), font=f)

    # ------------------------------------------------------------------ draw.io
    def drawio(self, page_idx):
        cells, ids, n = [], {}, [1]
        def nid(): n[0] += 1; return f'p{page_idx}c{n[0]}'
        esc = lambda s: html.escape(s, quote=True)
        for g in self.groups:
            r = self.grect(g); i = nid()
            cells.append(f'<mxCell id="{i}" value="{esc(g["title"])}" style="rounded=1;arcSize=3;whiteSpace=wrap;html=1;fillColor=#F7F8FA;strokeColor=#969696;verticalAlign=top;align=left;spacingLeft=10;spacingTop=2;fontStyle=1;fontSize=14;fontColor=#464646;container=0;" vertex="1" parent="1"><mxGeometry x="{r[0]}" y="{r[1]}" width="{r[2] - r[0]}" height="{r[3] - r[1]}" as="geometry"/></mxCell>')
        for nd in self.nodes.values():
            i = nid(); ids[nd.id] = i
            x0, y0, x1, y1 = nd.rect
            if nd.kind == 'start':
                st = 'ellipse;html=1;fillColor=#1E1E1E;strokeColor=#1E1E1E;verticalLabelPosition=bottom;verticalAlign=top;fontStyle=1;fontSize=11;'; val = nd.name
            elif nd.kind == 'end':
                st = 'ellipse;html=1;shape=endState;fillColor=#1E1E1E;strokeColor=#1E1E1E;'; val = ''
            elif nd.kind == 'decision':
                st = 'rhombus;whiteSpace=wrap;html=1;fillColor=#FFFAE1;strokeColor=#D6B656;fontStyle=1;fontSize=12;'; val = nd.name.replace('\n', '<br>')
            else:
                tp = TYPES[nd.kind]
                st = f'rounded=1;arcSize=12;whiteSpace=wrap;html=1;{tp[4]}strokeWidth=1.5;fontSize=13;'
                val = '<b>' + esc(nd.name).replace('\n', '<br>') + '</b>' + ('<br><font style="font-size:11px" color="#5F5F5F">' + esc(nd.route).replace('\n', '<br>') + '</font>' if nd.route else '')
            cells.append(f'<mxCell id="{i}" value="{val if nd.kind in ("decision",) else (val if nd.kind not in ("start","end") else esc(val))}" style="{st}" vertex="1" parent="1"><mxGeometry x="{x0}" y="{y0}" width="{nd.w}" height="{nd.h}" as="geometry"/></mxCell>')
        for e in self.edges:
            i = nid(); a, b = self.nodes[e['a']], self.nodes[e['b']]
            def rel(nd, p): return ((p[0] - nd.x) / nd.w, (p[1] - nd.y) / nd.h)
            ax, ay = rel(a, e['path'][0]); bx, by = rel(b, e['path'][-1])
            st = (f'edgeStyle=none;rounded=0;html=1;endArrow=block;endFill=1;strokeColor=#444444;strokeWidth=1.6;fontSize=11;labelBackgroundColor=#FFFFFF;'
                  f'exitX={ax:.4f};exitY={ay:.4f};exitDx=0;exitDy=0;entryX={bx:.4f};entryY={by:.4f};entryDx=0;entryDy=0;' + ('dashed=1;' if e['dash'] else ''))
            pts = ''.join(f'<mxPoint x="{p[0]}" y="{p[1]}"/>' for p in e['path'][1:-1])
            geo = f'<mxGeometry relative="1" as="geometry"><Array as="points">{pts}</Array></mxGeometry>' if pts else '<mxGeometry relative="1" as="geometry"/>'
            cells.append(f'<mxCell id="{i}" value="{esc(e["label"])}" style="{st}" edge="1" parent="1" source="{ids[e["a"]]}" target="{ids[e["b"]]}">{geo}</mxCell>')
        return (f'<diagram id="flow{page_idx}" name="{esc(self.title)}"><mxGraphModel dx="1400" dy="900" grid="1" gridSize="8" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{self.W}" pageHeight="{self.H}" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
                + ''.join(cells) + '</root></mxGraphModel></diagram>')


# ---------------------------------------------------------------------------------- geometry utils
def seg_rect(p, q, r):
    x0, y0, x1, y1 = r
    sx0, sx1 = sorted((p[0], q[0])); sy0, sy1 = sorted((p[1], q[1]))
    return sx0 < x1 and sx1 > x0 and sy0 < y1 and sy1 > y0

def seg_diamond(p, q, n):
    # sample points along the segment, test inside diamond (inflated by 2)
    L = max(abs(p[0] - q[0]), abs(p[1] - q[1]))
    for k in range(0, L + 1, 2):
        t = k / L if L else 0
        x = p[0] + (q[0] - p[0]) * t; y = p[1] + (q[1] - p[1]) * t
        if abs(x - n.cx) / (n.w / 2 - 1) + abs(y - n.cy) / (n.h / 2 - 1) < 1: return True
    return False

def collinear_overlap(p, q, r, s):
    if p[0] == q[0] and r[0] == s[0] and p[0] == r[0]:
        a0, a1 = sorted((p[1], q[1])); b0, b1 = sorted((r[1], s[1]))
        return max(0, min(a1, b1) - max(a0, b0))
    if p[1] == q[1] and r[1] == s[1] and p[1] == r[1]:
        a0, a1 = sorted((p[0], q[0])); b0, b1 = sorted((r[0], s[0]))
        return max(0, min(a1, b1) - max(a0, b0))
    return 0

def proper_cross(p, q, r, s):
    if (p[0] == q[0]) == (r[0] == s[0]): return False
    if p[0] == q[0]: p, q, r, s = r, s, p, q
    # now p-q horizontal, r-s vertical
    return min(p[0], q[0]) < r[0] < max(p[0], q[0]) and min(r[1], s[1]) < p[1] < max(r[1], s[1])

def arrow(dr, p, q, col, S, size=9):
    dx, dy = q[0] - p[0], q[1] - p[1]; L = math.hypot(dx, dy) or 1
    ux, uy = dx / L, dy / L; nx, ny = -uy, ux
    s = size * S
    a = (q[0] - ux * s + nx * s * 0.42, q[1] - uy * s + ny * s * 0.42)
    b = (q[0] - ux * s - nx * s * 0.42, q[1] - uy * s - ny * s * 0.42)
    dr.polygon([q, a, b], fill=col)

def dash_line(dr, p, q, col, w, dash, gap):
    L = math.hypot(q[0] - p[0], q[1] - p[1]);
    if L == 0: return
    ux, uy = (q[0] - p[0]) / L, (q[1] - p[1]) / L
    d = 0
    while d < L:
        e = min(d + dash, L)
        dr.line([(p[0] + ux * d, p[1] + uy * d), (p[0] + ux * e, p[1] + uy * e)], fill=col, width=int(w))
        d += dash + gap

def dash_rect(dr, box, col, S):
    x0, y0, x1, y1 = box
    r = 8 * S
    dash_line(dr, (x0 + r, y0), (x1 - r, y0), col, 1.3 * S, 6 * S, 4 * S)
    dash_line(dr, (x0 + r, y1), (x1 - r, y1), col, 1.3 * S, 6 * S, 4 * S)
    dash_line(dr, (x0, y0 + r), (x0, y1 - r), col, 1.3 * S, 6 * S, 4 * S)
    dash_line(dr, (x1, y0 + r), (x1, y1 - r), col, 1.3 * S, 6 * S, 4 * S)
    for (cx, cy, a0) in ((x0 + r, y0 + r, 180), (x1 - r, y0 + r, 270), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90)):
        dr.arc([cx - r, cy - r, cx + r, cy + r], a0, a0 + 90, fill=col, width=int(1.3 * S))
