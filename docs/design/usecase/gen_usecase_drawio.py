# -*- coding: utf-8 -*-
"""Sinh FITLY-usecase.drawio + preview PNG theo chuẩn UML (sàn đa gian hàng FITLY).

Quy ước UML áp dụng:
- Mỗi actor một lược đồ (one actor – one diagram); actor chính bên trái, actor phụ (hệ thống ngoài) bên ngoài biên hệ thống.
- Tên use case là CỤM ĐỘNG TỪ bắt đầu bằng động từ (Manage, View, Place ...) — kiểm bằng VERBS ở cuối file.
- Association = nét liền, không mũi tên. «include» (base → included) và «extend» (extending → base) = nét đứt + mũi tên mở, có nhãn.
  Generalization = nét liền + tam giác rỗng chỉ về cha.
- Mọi đường là đoạn thẳng. KHÔNG đường nào được cắt qua ô hình oval của use case khác, không đường nào cắt nhau,
  các oval không đè nhau: bố cục toả tia (radial) quanh actor, tự dò tham số rồi KIỂM HÌNH HỌC (assert) trước khi xuất.
Chạy: python gen_usecase_drawio.py
"""
import io, os, html, math, itertools
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
PREVIEW_DIR = os.path.join(OUT_DIR, 'preview')

UC_W, UC_H = 190, 54
A_, B_ = UC_W / 2, UC_H / 2
ACT_W, ACT_H = 30, 60
STORE, VENDOR, ADMIN = 'FITLY Storefront', 'FITLY Vendor Portal', 'FITLY Admin Portal'

# ----------------------------------------------------------------------------------------------- dữ liệu
# nodes: use case nối trực tiếp với actor chính · rel: (extend|include|gen, base, other) · ext: (use case, actor phụ)
# other-only use case được khai ở `others`. gen: other = con, base = cha (mũi tên từ con tới cha).
PAGES = [
    dict(name='Guest - Browsing & Account', system=STORE, actor='Guest',
         external=[('Google', 'Google OAuth')],
         nodes=[('a', 'Register Account'), ('b', 'Log In with Google'), ('c', 'Search & Filter Products'),
                ('d', 'View Product Details'), ('e', 'View Shop Page'), ('f', 'View Product Reviews'),
                ('g', 'View Collections & Banners'), ('h', 'View FAQs & Content Pages'),
                ('i', 'Manage Shopping Cart'), ('j', 'Submit Contact Inquiry')],
         others={'i2': 'Apply Voucher Code'}, rel=[('extend', 'i', 'i2')], ext=[('b', 'Google')]),
    dict(name='Guest - AI Assistant', system=STORE, actor='Guest',
         external=[('AI', 'AI Provider')],
         nodes=[('a', 'Chat with AI Assistant'), ('b', 'Search Products by Image'), ('c', 'Try On Garment Virtually'),
                ('d', 'Analyze Style Profile'), ('e', 'Compare Products'), ('f', 'View Recommendations')],
         others={'a2': 'Request Live Staff Support'}, rel=[('extend', 'a', 'a2')],
         ext=[('a', 'AI'), ('b', 'AI'), ('c', 'AI'), ('d', 'AI'), ('e', 'AI')]),
    dict(name='Customer - Account & Reviews', system=STORE, actor='Customer', external=[],
         nodes=[('a', 'Manage Profile'), ('b', 'Manage Address Book'), ('c', 'Manage Wishlist'),
                ('d', 'View Notifications'), ('e', 'View Login History'), ('f', 'Confirm Chatbot Action'),
                ('g', 'Submit Product Review'), ('h', 'Edit or Delete My Review')],
         others={'g2': 'Attach Review Photos'}, rel=[('extend', 'g', 'g2')], ext=[]),
    dict(name='Customer - Orders & Payment', system=STORE, actor='Customer',
         external=[('PayOS', 'PayOS')],
         nodes=[('a', 'Place Order'), ('c', 'Track Orders'), ('d', 'Cancel Order'),
                ('e', 'Request Return or Exchange')],
         others={'a2': 'Make Payment', 'a3': 'Pay via COD', 'a4': 'Pay via PayOS',
                 'b': 'Retry Payment', 'e2': 'Upload Evidence Photos'},
         rel=[('include', 'a', 'a2'), ('gen', 'a2', 'a3'), ('gen', 'a2', 'a4'), ('extend', 'a2', 'b'),
              ('include', 'e', 'e2')],
         ext=[('a4', 'PayOS'), ('b', 'PayOS')]),
    dict(name='Staff', system=ADMIN, actor='Staff', external=[],
         nodes=[('a', 'View Profile & Permissions'), ('b', 'View Internal Notifications'), ('c', 'View Login History')],
         others={}, rel=[], ext=[]),
    dict(name='Sales & Support', system=ADMIN, actor='Sales & Support', external=[('AI', 'AI Provider')],
         nodes=[('a', 'View Products & Stock'), ('b', 'View Orders'), ('c', 'Update Order Status'),
                ('d', 'Cancel Order for Customer'), ('e', 'Process Return Request'), ('f', 'Reply to Reviews'),
                ('g', 'Handle Chatbot Support Requests'), ('h', 'View Chatbot Logs'),
                ('i', 'Send Notification to Customer')],
         others={'f2': 'Draft Reply with AI'}, rel=[('extend', 'f', 'f2')], ext=[('f2', 'AI')]),
    dict(name='Warehouse Staff', system=ADMIN, actor='Warehouse Staff', external=[],
         nodes=[('a', 'View Stock Levels'), ('b', 'Create Goods Receipt Note'), ('c', 'Adjust or Audit Stock'),
                ('d', 'View Stock Movement Ledger'), ('e', 'View Inventory Reports'),
                ('f', 'Pack & Hand Over Order'), ('g', 'Receive Returned Goods')],
         others={'b2': 'Post Goods Receipt Note'}, rel=[('extend', 'b', 'b2')], ext=[]),
    dict(name='Accountant - Payments & Refunds', system=ADMIN, actor='Accountant', external=[('PayOS', 'PayOS')],
         nodes=[('a', 'View Orders'), ('b', 'View Payment Transactions'), ('c', 'Create Refund Request'), ('d', 'Process Refund'), ('e', 'View Revenue Reports')],
         others={}, rel=[], ext=[('d', 'PayOS')]),
    dict(name='Accountant - Shop Payout', system=ADMIN, actor='Accountant', external=[('PayOS', 'PayOS')],
         nodes=[('a', 'Run Shop Payout'), ('b', 'Monitor PayOS Payout Balance'), ('c', 'View Payout Runs')],
         others={'c2': 'Mark Payout as Paid', 'c3': 'Retry Failed Payout'},
         rel=[('extend', 'c', 'c2'), ('extend', 'c', 'c3')], ext=[('a', 'PayOS'), ('b', 'PayOS'), ('c3', 'PayOS')]),
    dict(name='Marketing', system=ADMIN, actor='Marketing', external=[('AI', 'AI Provider')],
         nodes=[('a', 'Manage Platform Vouchers'), ('b', 'Manage Homepage Banners'), ('c', 'Manage Collections'),
                ('d', 'Send Campaign Notification'), ('e', 'Draft Content with AI'),
                ('f', 'Manage AI Knowledge Base'), ('g', 'View Analytics Dashboard')],
         others={}, rel=[], ext=[('e', 'AI'), ('f', 'AI')]),
    dict(name='Platform Manager', system=ADMIN, actor='Platform Manager', external=[('AI', 'AI Provider')],
         nodes=[('a', 'Manage Categories'), ('b', 'Manage Attributes'), ('c', 'Manage Dynamic Attributes'),
                ('d', 'Approve or Reject Shops'), ('e', 'Suspend Shop'), ('f', 'Set Shop Commission Rate'),
                ('g', 'Publish or Hide Products'), ('h', 'Moderate Reviews'), ('i', 'View Shop Payouts'),
                ('j', 'View AI Operations Insights'), ('k', 'View Employee Directory'), ('l', 'View System Settings')],
         others={'h2': 'Review AI Moderation Flags'}, rel=[('extend', 'h', 'h2')], ext=[('h2', 'AI'), ('j', 'AI')],
         note='Also performs the use cases of Sales & Support, Warehouse Staff, Accountant and Marketing (shared operational permissions).'),
    dict(name='Administrator', system=ADMIN, actor='Administrator', external=[],
         nodes=[('a', 'Manage Staff Accounts'), ('b', 'Lock or Unlock Accounts'), ('c', 'Manage Roles & Permissions'),
                ('d', 'Assign Custom Permissions'), ('e', 'View Audit Logs'), ('f', 'Configure System Settings'),
                ('g', 'Manage Provinces & Shipping Fees'), ('h', 'Toggle Payment Methods'),
                ('i', 'Monitor AI Costs & Quotas')],
         others={'a2': 'Reset Staff Password'}, rel=[('extend', 'a', 'a2')], ext=[],
         note='Full access (admin role = all permissions): also performs every use case of Platform Manager, Sales & Support, Warehouse Staff, Accountant and Marketing.'),
    dict(name='Shop Staff', system=VENDOR, actor='Shop Staff', external=[],
         nodes=[('a', 'View Shop Profile'), ('b', 'View Shop Staff List'), ('c', 'View Shop Products'),
                ('d', 'Create or Update Product'), ('e', 'View Shop Orders'), ('f', 'Update Shop Order Status'),
                ('g', 'View Shop Inventory'), ('h', 'View Shop Reviews'), ('i', 'Reply to Shop Reviews')],
         others={}, rel=[], ext=[]),
    dict(name='Shop Owner', system=VENDOR, actor='Shop Owner', external=[],
         nodes=[('a', 'Update Shop Profile & Bank Account'), ('b', 'Add Shop Staff'), ('c', 'Change Staff Role'),
                ('d', 'Remove Shop Staff'), ('e', 'Manage Inventory Receipts'), ('f', 'Adjust Shop Stock'),
                ('g', 'Manage Shop Vouchers'), ('h', 'View Shop Reports'),
                ('i', 'View Shop Payout Runs')],
         others={}, rel=[], ext=[],
         note='Shop Owner IS-A Shop Staff: also performs every use case of Shop Staff.'),
]

AUTH = dict(name='Authentication & Actor Hierarchy', system='FITLY System',
            actor='User',
            nodes=[('a', 'Log In'), ('b', 'Log Out'), ('c', 'Change Password'), ('d', 'Reset Forgotten Password')],
            external=[('Mail', 'Email Service')], ext=[('d', 'Mail')])
# actor hierarchy (x, y tuyệt đối trên canvas); gen: (con, cha)
HIER = {'Administrator': (110, 70), 'Platform Manager': (110, 170), 'Sales & Support': (110, 270), 'Warehouse Staff': (110, 370),
        'Accountant': (110, 470), 'Marketing': (110, 570), 'Staff': (400, 320),
        'Shop Owner': (110, 740), 'Shop Staff': (400, 740), 'Customer': (400, 900), 'Guest': (110, 900)}
HIER_GEN = [('Administrator', 'Staff'), ('Platform Manager', 'Staff'), ('Sales & Support', 'Staff'),
            ('Warehouse Staff', 'Staff'), ('Accountant', 'Staff'), ('Marketing', 'Staff'),
            ('Shop Owner', 'Shop Staff'), ('Customer', 'Guest')]
HIER_TO_USER = ['Staff', 'Shop Staff', 'Customer']

# ----------------------------------------------------------------------------------------------- hình học
def rb(dx, dy):
    """bán kính tới biên oval theo hướng (dx,dy)"""
    return 1 / math.sqrt((dx / A_) ** 2 + (dy / B_) ** 2)

def rot(v, deg):
    r = math.radians(deg); c, s = math.cos(r), math.sin(r)
    return (v[0] * c - v[1] * s, v[0] * s + v[1] * c)

def unit(v):
    L = math.hypot(*v); return (v[0] / L, v[1] / L)

def in_ell(p, c, infl=0.0):
    return ((p[0] - c[0]) / (A_ + infl)) ** 2 + ((p[1] - c[1]) / (B_ + infl)) ** 2 < 1

def ell_overlap(c1, c2, infl):
    for t in range(0, 360, 5):
        r = math.radians(t)
        if in_ell((c1[0] + (A_ + infl) * math.cos(r), c1[1] + (B_ + infl) * math.sin(r)), c2, infl): return True
        if in_ell((c2[0] + (A_ + infl) * math.cos(r), c2[1] + (B_ + infl) * math.sin(r)), c1, infl): return True
    return in_ell(c1, c2, infl)

def clip_ell(c, toward):
    dx, dy = toward[0] - c[0], toward[1] - c[1]
    L = math.hypot(dx, dy); ux, uy = dx / L, dy / L; s = rb(ux, uy)
    return (c[0] + ux * s, c[1] + uy * s)

def clip_box(c, toward, hw=15, hh=30):
    dx, dy = toward[0] - c[0], toward[1] - c[1]
    s = min(hw / abs(dx) if dx else 9e9, hh / abs(dy) if dy else 9e9)
    return (c[0] + dx * s, c[1] + dy * s)

def seg_pts(p, q, step=4):
    L = math.hypot(q[0] - p[0], q[1] - p[1]); n = max(2, int(L / step))
    return [(p[0] + (q[0] - p[0]) * i / n, p[1] + (q[1] - p[1]) * i / n) for i in range(n + 1)]

def seg_cross(p1, p2, p3, p4):
    def o(a, b, c): return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    d1, d2, d3, d4 = o(p3, p4, p1), o(p3, p4, p2), o(p1, p2, p3), o(p1, p2, p4)
    return d1 * d2 < 0 and d3 * d4 < 0

def seg_hits_box(p, q, box):
    x0, y0, x1, y1 = box
    return any(x0 < x < x1 and y0 < y < y1 for x, y in seg_pts(p, q, 3))

def actor_box(c): return (c[0] - 40, c[1] - 36, c[0] + 40, c[1] + 56)
def label_box(c): return (c[0] - 42, c[1] + 31, c[0] + 42, c[1] + 54)

# ----------------------------------------------------------------------------------------------- bố cục
class Fail(Exception): pass

def build(d, rx, ry, span, gapL, alpha):
    """vị trí tương đối (actor ở gốc 0,0) — trả về dict nid → (x,y)"""
    pos = {}
    nodes = [n for n, _ in d['nodes']]; n = len(nodes)
    kids = {}
    for kind, base, other in d['rel']: kids.setdefault(base, []).append((kind, other))
    def place(base, direction):
        ks = kids.get(base, [])
        for k, (kind, other) in enumerate(ks):
            m = len(ks)
            off = (k - (m - 1) / 2) * alpha if m > 1 else (alpha * 0.6 if direction[1] >= 0 else -alpha * 0.6)
            dd = unit(rot(direction, off))
            dist = rb(*direction) + rb(*dd) + gapL
            pos[other] = (pos[base][0] + dd[0] * dist, pos[base][1] + dd[1] * dist)
            place(other, dd)
    for i, nid in enumerate(nodes):
        th = 0 if n == 1 else -span + 2 * span * i / (n - 1)
        pos[nid] = (rx * math.cos(math.radians(th)), ry * math.sin(math.radians(th)))
    for nid in nodes:
        dirv = unit(pos[nid]); place(nid, dirv)
    return pos

def edges_of(d, pos, names_actor=(0, 0)):
    """danh sách cạnh: dict(kind,a,b,p,q,label)  — p,q là hai đầu đã cắt tại biên; a,b là id đầu mút"""
    E = []
    A = names_actor
    for nid, _ in d['nodes']:
        c = pos[nid]
        E.append(dict(kind='assoc', a='@actor', b=nid, p=clip_box(A, c), q=clip_ell(c, A)))
    for kind, base, other in d['rel']:
        cb, co = pos[base], pos[other]
        pb, po = clip_ell(cb, co), clip_ell(co, cb)
        if kind == 'extend': E.append(dict(kind='extend', a=other, b=base, p=po, q=pb, label='«extend»'))
        elif kind == 'include': E.append(dict(kind='include', a=base, b=other, p=pb, q=po, label='«include»'))
        else: E.append(dict(kind='gen', a=other, b=base, p=po, q=pb))
    return E

def label_rect(e):
    mx, my = (e['p'][0] + e['q'][0]) / 2, (e['p'][1] + e['q'][1]) / 2
    w = len(e['label']) * 6.2 / 2 + 4
    return (mx - w, my - 9, mx + w, my + 9)

def rect_hits_ell(r, c, infl=3):
    x0, y0, x1, y1 = r
    return any(in_ell((x, y), c, infl) for x in (x0, (x0 + x1) / 2, x1) for y in (y0, y1)) or in_ell(((x0 + x1) / 2, (y0 + y1) / 2), c, infl)

def validate(pos, E, extra_actors=(), actors0=((0, 0),), min_gap=12):
    ids = list(pos)
    if any(p[0] - A_ < 75 for p in pos.values()): return 'oval-left-of-actor'
    for i, j in itertools.combinations(ids, 2):
        if ell_overlap(pos[i], pos[j], min_gap / 2): return 'oval-overlap'
    for e in E:
        if e['a'] == '@actor' and seg_hits_box(e['p'], e['q'], label_box((0, 0))): return 'line-over-actor-label'
        for nid in ids:
            if nid in (e['a'], e['b']): continue
            if any(in_ell(pt, pos[nid], 4) for pt in seg_pts(e['p'], e['q'])): return 'line-through-oval'
        if 'label' in e:
            if math.hypot(e['q'][0] - e['p'][0], e['q'][1] - e['p'][1]) < 78: return 'edge-too-short'
            r = label_rect(e)
            for nid in ids:
                if rect_hits_ell(r, pos[nid]): return 'label-on-oval'
    for e1, e2 in itertools.combinations(E, 2):
        if {e1['a'], e1['b']} & {e2['a'], e2['b']}: continue
        if seg_cross(e1['p'], e1['q'], e2['p'], e2['q']): return 'lines-cross'
    return None

def layout(d):
    combos = []
    for span in (35, 45, 55, 65, 72):
        for rx in range(300, 1001, 50):
            for ry in range(260, 1301, 50):
                if rx * math.cos(math.radians(span)) < A_ + 90: continue
                for gapL in (95, 130, 170):
                    for alpha in (28, 40, 52):
                        combos.append((rx * ry + gapL * 400, span, rx, ry, gapL, alpha))
    combos.sort()
    for _, span, rx, ry, gapL, alpha in combos:
        pos = build(d, rx, ry, span, gapL, alpha)
        E = edges_of(d, pos)
        if not validate(pos, E): return pos, E
    raise Fail('không tìm được bố cục hợp lệ cho ' + d['name'])

def boundary_of(pos, E, system):
    xs0 = [p[0] - A_ for p in pos.values()]; xs1 = [p[0] + A_ for p in pos.values()]
    ys0 = [p[1] - B_ for p in pos.values()]; ys1 = [p[1] + B_ for p in pos.values()]
    wt = len(system) * 8 + 40
    left, right = min(xs0) - 30, max(xs1) + 30
    if right - left < wt: right = left + wt
    return [left, min(ys0) - 52, right, max(ys1) + 30]

def place_externals(d, pos, E, bound):
    """đặt actor phụ ngoài biên; chọn vị trí hợp lệ (đường thẳng không cắt oval/đường khác) có tổng độ dài ngắn nhất"""
    ext = {}
    ext_edges = []
    allE = list(E)
    names = dict(d['external'])
    groups = {}
    for uc, a in d['ext']: groups.setdefault(a, []).append(uc)
    order = sorted(groups, key=lambda a: sum(pos[u][1] for u in groups[a]) / len(groups[a]))
    for a in order:
        cands = []
        l, t, r, b = bound
        for y in range(int(t) - 60, int(b) + 61, 20):
            for x in (r + 110, r + 170, r + 240, r + 320):
                cands.append((x, y))
        for x in range(int(l) - 60, int(r) + 61, 40):
            for y in (t - 90, t - 150, b + 90, b + 150):
                cands.append((x, y))
        scored = []
        for c in cands:
            if any(abs(c[0] - o['c'][0]) < 110 and abs(c[1] - o['c'][1]) < 110 for o in ext.values()): continue
            if any(abs(c[0] - 0) < 90 and abs(c[1] - 0) < 110 for _ in [0]): continue
            ne = []
            ok = True
            for uc in groups[a]:
                ne.append(dict(kind='assoc', a='@ext:' + a, b=uc, p=clip_box(c, pos[uc]), q=clip_ell(pos[uc], c)))
            for e in ne:
                for nid in pos:
                    if nid == e['b']: continue
                    if any(in_ell(pt, pos[nid], 4) for pt in seg_pts(e['p'], e['q'])): ok = False; break
                if not ok: break
                for o in allE:
                    if e['b'] in (o['a'], o['b']) and o['kind'] != 'assoc': pass
                    if {e['a'], e['b']} & {o['a'], o['b']}: continue
                    if seg_cross(e['p'], e['q'], o['p'], o['q']): ok = False; break
                if not ok: break
                for o in ext.values():
                    if seg_hits_box(e['p'], e['q'], actor_box(o['c'])): ok = False; break
                if not ok: break
                if seg_hits_box(e['p'], e['q'], actor_box((0, 0))): ok = False; break
                if seg_hits_box(e['p'], e['q'], label_box(c)): ok = False; break
            if not ok: continue
            for e1, e2 in itertools.combinations(ne, 2):
                if seg_cross(e1['p'], e1['q'], e2['p'], e2['q']): ok = False
            if any(seg_hits_box(o['p'], o['q'], actor_box(c)) for o in ext_edges): ok = False
            if not ok: continue
            length = sum(math.hypot(e['q'][0] - e['p'][0], e['q'][1] - e['p'][1]) for e in ne)
            scored.append((length, c, ne))
        if not scored: raise Fail(f'không đặt được actor phụ {a} trong {d["name"]}')
        scored.sort(key=lambda s: s[0])
        _, c, ne = scored[0]
        ext[a] = dict(c=c, name=names[a]); allE += ne; ext_edges += ne
    return ext, ext_edges

def note_rect(d):
    return (-180, 90, 170, 110)

def compose(d):
    pos, E = layout(d)
    bound = boundary_of(pos, E, d['system'])
    ext, EE = place_externals(d, pos, E, bound)
    # bao hết canvas
    pts = [(bound[0], bound[1]), (bound[2], bound[3]), (-190, -40), (-20, 130)]
    for o in ext.values(): pts += [(o['c'][0] - 60, o['c'][1] - 50), (o['c'][0] + 60, o['c'][1] + 80)]
    if d.get('note'): pts += [(-190, 215)]
    ox = 30 - min(p[0] for p in pts); oy = 30 - min(p[1] for p in pts)
    W = int(max(p[0] for p in pts) + ox + 30); H = int(max(p[1] for p in pts) + oy + 30)
    return dict(pos=pos, E=E, EE=EE, ext=ext, bound=bound, off=(ox, oy), size=(W, H))

# ----------------------------------------------------------------------------------------------- draw.io
def esc(s): return html.escape(s, quote=True)
S_ACTOR = 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;'
S_UC = 'ellipse;whiteSpace=wrap;html=1;fontSize=12;fillColor=#FFFFFF;'
S_NOTE = 'shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;size=14;align=left;verticalAlign=top;fontSize=11;spacing=6;'
S_BOUND = 'rounded=0;whiteSpace=wrap;html=1;fillColor=none;verticalAlign=top;fontStyle=1;fontSize=14;spacingTop=4;'
E0 = 'edgeStyle=none;html=1;rounded=0;'
ST = dict(assoc=E0 + 'endArrow=none;', extend=E0 + 'dashed=1;endArrow=open;endFill=0;fontSize=11;',
          include=E0 + 'dashed=1;endArrow=open;endFill=0;fontSize=11;', gen=E0 + 'endArrow=block;endFill=0;endSize=12;')

class Page:
    def __init__(self, name): self.name, self.cells, self.n = name, [], 1
    def nid(self): self.n += 1; return f'c{self.n}'
    def vertex(self, value, style, x, y, w, h):
        i = self.nid()
        self.cells.append(f'<mxCell id="{i}" value="{esc(value)}" style="{style}" vertex="1" parent="1"><mxGeometry x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" as="geometry"/></mxCell>')
        return i
    def edge(self, s, t, style, value=''):
        i = self.nid()
        self.cells.append(f'<mxCell id="{i}" value="{esc(value)}" style="{style}" edge="1" parent="1" source="{s}" target="{t}"><mxGeometry relative="1" as="geometry"/></mxCell>')
    def xml(self, idx):
        return (f'<diagram id="page{idx}" name="{esc(self.name)}"><mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
                + ''.join(self.cells) + '</root></mxGraphModel></diagram>')

def shift(p, o): return (p[0] + o[0], p[1] + o[1])

def drawio_page(d, L):
    o = L['off']; p = Page(d['name']); ids = {}
    names = dict(d['nodes']); names.update(d['others'])
    bx, by, br, bb = L['bound']
    p.vertex(d['system'], S_BOUND, bx + o[0], by + o[1], br - bx, bb - by)
    for nid, c in L['pos'].items():
        ids[nid] = p.vertex(names[nid], S_UC, c[0] + o[0] - A_, c[1] + o[1] - B_, UC_W, UC_H)
    ids['@actor'] = p.vertex(d['actor'], S_ACTOR, o[0] - ACT_W / 2, o[1] - ACT_H / 2, ACT_W, ACT_H)
    for a, e in L['ext'].items():
        ids['@ext:' + a] = p.vertex(e['name'], S_ACTOR, e['c'][0] + o[0] - ACT_W / 2, e['c'][1] + o[1] - ACT_H / 2, ACT_W, ACT_H)
    for e in L['E'] + L['EE']:
        p.edge(ids[e['a']], ids[e['b']], ST[e['kind']], e.get('label', ''))
    if d.get('note'):
        nx, ny, nw, nh = note_rect(d)
        nid = p.vertex(d['note'], S_NOTE, nx + o[0], ny + o[1], nw, nh)
        p.edge(nid, ids['@actor'], E0 + 'dashed=1;endArrow=none;')
    return p

# ----------------------------------------------------------------------------------------------- PNG
try:
    FONT = ImageFont.truetype(r'C:\Windows\Fonts\arial.ttf', 13)
    FONT_B = ImageFont.truetype(r'C:\Windows\Fonts\arialbd.ttf', 15)
    FONT_S = ImageFont.truetype(r'C:\Windows\Fonts\arial.ttf', 11)
except Exception:
    FONT = FONT_B = FONT_S = ImageFont.load_default()

def wrap(text, width_px, font):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if font.getlength(t) <= width_px: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

def draw_actor(dr, cx, cy, name):
    dr.ellipse((cx - 8, cy - 30, cx + 8, cy - 14), outline='black', fill='white', width=2)
    dr.line((cx, cy - 14, cx, cy + 8), fill='black', width=2); dr.line((cx - 14, cy - 6, cx + 14, cy - 6), fill='black', width=2)
    dr.line((cx, cy + 8, cx - 12, cy + 30), fill='black', width=2); dr.line((cx, cy + 8, cx + 12, cy + 30), fill='black', width=2)
    lines = wrap(name, 140, FONT)
    for k, ln in enumerate(lines): dr.text((cx - FONT.getlength(ln) / 2, cy + 36 + k * 15), ln, fill='black', font=FONT)

def dashed(dr, p1, p2, dash=7, gap=5):
    L = math.hypot(p2[0] - p1[0], p2[1] - p1[1]); ux, uy = (p2[0] - p1[0]) / L, (p2[1] - p1[1]) / L; t = 0
    while t < L:
        e = min(t + dash, L); dr.line((p1[0] + ux * t, p1[1] + uy * t, p1[0] + ux * e, p1[1] + uy * e), fill='black', width=1); t += dash + gap

def arrow_head(dr, tip, frm, kind):
    L = math.hypot(tip[0] - frm[0], tip[1] - frm[1]); ux, uy = (tip[0] - frm[0]) / L, (tip[1] - frm[1]) / L
    px, py = -uy, ux; s = 12 if kind == 'tri' else 10
    a = (tip[0] - ux * s + px * s * 0.5, tip[1] - uy * s + py * s * 0.5); b = (tip[0] - ux * s - px * s * 0.5, tip[1] - uy * s - py * s * 0.5)
    if kind == 'open': dr.line((a, tip), fill='black'); dr.line((b, tip), fill='black')
    else: dr.polygon([tip, a, b], outline='black', fill='white')

def draw_uc(dr, c, name):
    dr.ellipse((c[0] - A_, c[1] - B_, c[0] + A_, c[1] + B_), outline='black', fill='white', width=1)
    lines = wrap(name, UC_W - 34, FONT)
    for k, ln in enumerate(lines):
        dr.text((c[0] - FONT.getlength(ln) / 2, c[1] - 8 * len(lines) + k * 16 + 1), ln, fill='black', font=FONT)

def draw_note(dr, rect, text):
    x0, y0, x1, y1 = rect
    dr.polygon([(x0, y0), (x1 - 14, y0), (x1, y0 + 14), (x1, y1), (x0, y1)], outline='black', fill='white')
    for k, ln in enumerate(wrap(text, x1 - x0 - 12, FONT_S)): dr.text((x0 + 6, y0 + 8 + k * 14), ln, fill='black', font=FONT_S)

def render_edge(dr, e, S):
    p, q = S(e['p']), S(e['q'])
    if e['kind'] == 'assoc': dr.line((p, q), fill='black')
    elif e['kind'] == 'gen': dr.line((p, q), fill='black'); arrow_head(dr, q, p, 'tri')
    else:
        dashed(dr, p, q); arrow_head(dr, q, p, 'open')
        mx, my = (p[0] + q[0]) / 2, (p[1] + q[1]) / 2; tw = FONT_S.getlength(e['label'])
        dr.rectangle((mx - tw / 2 - 2, my - 8, mx + tw / 2 + 2, my + 8), fill='white'); dr.text((mx - tw / 2, my - 7), e['label'], fill='black', font=FONT_S)

def png_page(d, L, path):
    o = L['off']; W, H = L['size']; S = lambda p: shift(p, o)
    img = Image.new('RGB', (W, H), 'white'); dr = ImageDraw.Draw(img)
    bx, by, br, bb = L['bound']; x0, y0 = S((bx, by)); x1, y1 = S((br, bb))
    dr.rectangle((x0, y0, x1, y1), outline='black', width=2)
    dr.text(((x0 + x1) / 2 - FONT_B.getlength(d['system']) / 2, y0 + 8), d['system'], fill='black', font=FONT_B)
    for e in L['E'] + L['EE']: render_edge(dr, e, S)
    names = dict(d['nodes']); names.update(d['others'])
    for nid, c in L['pos'].items(): draw_uc(dr, S(c), names[nid])
    ax, ay = S((0, 0)); draw_actor(dr, ax, ay, d['actor'])
    for e in L['ext'].values(): draw_actor(dr, *S(e['c']), e['name'])
    if d.get('note'):
        nx, ny, nw, nh = note_rect(d); nx0, ny0 = S((nx, ny)); r = (nx0, ny0, nx0 + nw, ny0 + nh)
        draw_note(dr, r, d['note']); dashed(dr, ((r[0] + r[2]) / 2, r[1]), (ax, ay + 64), 4, 3)
    img.save(path)

# ----------------------------------------------------------------------------------------------- trang 0: auth + hierarchy
def compose_auth():
    d = dict(AUTH, others={}, rel=[], ext=AUTH['ext'])
    pos, E = layout(d)
    bound = boundary_of(pos, E, d['system'])
    ext, EE = place_externals(d, pos, E, bound)
    return d, pos, E, bound, ext, EE

def auth_page():
    d, pos, E, bound, ext, EE = compose_auth()
    ux, uy = 760, 560
    o = (ux, uy)
    # hệ toạ độ tuyệt đối = tương đối + o
    A = {k: v for k, v in HIER.items()}; A['User'] = (ux, uy)
    gen = [(c, p) for c, p in HIER_GEN] + [(c, 'User') for c in HIER_TO_USER]
    segs = []
    for c, p in gen:
        pc, pp = A[c], A[p]
        segs.append((c, p, clip_box(pc, pp), clip_box(pp, pc)))
    for (c1, p1, a1, b1), (c2, p2, a2, b2) in itertools.combinations(segs, 2):
        if {c1, p1} & {c2, p2}: continue
        assert not seg_cross(a1, b1, a2, b2), f'phân cấp cắt nhau {c1}>{p1} x {c2}>{p2}'
    for c, p, a, b in segs:
        for k, v in A.items():
            if k in (c, p): continue
            assert not seg_hits_box(a, b, actor_box(v)), f'đường {c}>{p} đè actor {k}'
    pts = [(bound[0] + ox, bound[1] + oy) for ox, oy in [o]] + [(bound[2] + o[0], bound[3] + o[1])]
    W = int(max([bound[2] + o[0]] + [e['c'][0] + o[0] for e in ext.values()]) + 120); H = 1010
    img = Image.new('RGB', (W, H), 'white'); dr = ImageDraw.Draw(img)
    S = lambda p: shift(p, o)
    bx, by, br, bb = bound; x0, y0 = S((bx, by)); x1, y1 = S((br, bb))
    dr.rectangle((x0, y0, x1, y1), outline='black', width=2)
    dr.text(((x0 + x1) / 2 - FONT_B.getlength(d['system']) / 2, y0 + 8), d['system'], fill='black', font=FONT_B)
    for e in E + EE: render_edge(dr, e, S)
    for c, p, a, b in segs: dr.line((a, b), fill='black'); arrow_head(dr, b, a, 'tri')
    names = dict(d['nodes'])
    for nid, c in pos.items(): draw_uc(dr, S(c), names[nid])
    for k, v in A.items(): draw_actor(dr, v[0], v[1], k)
    for e in ext.values(): draw_actor(dr, *S(e['c']), e['name'])
    # drawio
    pg = Page(AUTH['name']); ids = {}
    pg.vertex(d['system'], S_BOUND, x0, y0, x1 - x0, y1 - y0)
    for nid, c in pos.items(): ids[nid] = pg.vertex(names[nid], S_UC, S(c)[0] - A_, S(c)[1] - B_, UC_W, UC_H)
    for k, v in A.items(): ids[k] = pg.vertex(k, S_ACTOR, v[0] - ACT_W / 2, v[1] - ACT_H / 2, ACT_W, ACT_H)
    for a, e in ext.items(): ids['@ext:' + a] = pg.vertex(e['name'], S_ACTOR, S(e['c'])[0] - ACT_W / 2, S(e['c'])[1] - ACT_H / 2, ACT_W, ACT_H)
    for c, p in gen: pg.edge(ids[c], ids[p], ST['gen'])
    for e in E + EE:
        a = 'User' if e['a'] == '@actor' else e['a']
        pg.edge(ids[a], ids[e['b']], ST[e['kind']], e.get('label', ''))
    return img, pg

# ----------------------------------------------------------------------------------------------- kiểm động từ
VERBS = {'Register', 'Log', 'Change', 'Reset', 'Search', 'View', 'Manage', 'Submit', 'Apply', 'Chat', 'Try', 'Analyze', 'Compare',
         'Request', 'Edit', 'Confirm', 'Attach', 'Place', 'Retry', 'Track', 'Cancel', 'Make', 'Pay', 'Upload', 'Update', 'Process',
         'Reply', 'Handle', 'Send', 'Create', 'Adjust', 'Pack', 'Receive', 'Post', 'Review', 'Run', 'Mark', 'Draft', 'Publish',
         'Approve', 'Suspend', 'Set', 'Moderate', 'Lock', 'Assign', 'Configure', 'Monitor', 'Toggle', 'Add', 'Remove', 'Monitor'}

def check_verbs():
    names = [n for p in PAGES for n in [x[1] for x in p['nodes']] + list(p['others'].values())] + [x[1] for x in AUTH['nodes']]
    bad = [n for n in names if n.split()[0] not in VERBS]
    assert not bad, f'tên use case không bắt đầu bằng động từ: {bad}'

# ----------------------------------------------------------------------------------------------- main
if __name__ == '__main__':
    check_verbs()
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    for f in os.listdir(PREVIEW_DIR): os.remove(os.path.join(PREVIEW_DIR, f))
    img, pg0 = auth_page()
    img.save(os.path.join(PREVIEW_DIR, '0-authentication-actor-hierarchy.png'))
    pages = [pg0]
    for i, d in enumerate(PAGES, 1):
        L = compose(d)
        pages.append(drawio_page(d, L))
        slug = d['name'].lower().replace(' & ', '-').replace(' - ', '-').replace(' ', '-')
        png_page(d, L, os.path.join(PREVIEW_DIR, f'{i}-{slug}.png'))
        print('ok', d['name'], L['size'])
    xml = '<mxfile host="app.diagrams.net" agent="fitly-usecase-generator" version="24.7.0">' + ''.join(p.xml(i) for i, p in enumerate(pages)) + '</mxfile>'
    io.open(os.path.join(OUT_DIR, 'FITLY-usecase.drawio'), 'w', encoding='utf-8', newline='\n').write(xml)
    print('done', len(pages), 'pages')
