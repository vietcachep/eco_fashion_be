# -*- coding: utf-8 -*-
"""Generate FITLY-usecase.drawio (10 pages) following the "one actor – one diagram" pattern:
- Page 1 "Authentication & Actor Hierarchy": Actor generalization tree (empty triangle arrows to parent) + User -> auth use cases.
- One page per actor: Primary actor on the left, fan of straight lines to use cases arranged in 2 staggered columns inside system boundary;
  «extend»/«include»/child use cases in adjacent column, connected with straight lines; external actors on the right connected directly with straight lines.
Coordinates pre-calculated; preview PNGs generated via PIL with matching coordinates for verification.
Run: python gen_usecase_drawio.py
"""
import io, os, html, math
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
PREVIEW_DIR = os.path.join(OUT_DIR, 'preview')

ACT_W, ACT_H = 30, 60
UC_W, UC_H = 200, 50
P = 64                         # row step
COL_X = [230, 530, 830, 1130]  # left edge of use case columns (200 ellipse + 100 space for labels)
BOUND_X, BOUND_Y = 180, 30
ACTOR_CX = 75

STORE = 'FITLY Storefront'
ADMIN = 'FITLY Admin Portal'

# nodes: (id, name) directly connected to actor · others: use cases appearing via relationships
# rel: (extend|include|gen, base, other) · ext: (use case, external actor)
PAGES = [
    dict(name='Guest', system=STORE, actor='Guest',
         external=[('Google', 'Google OAuth'), ('AI', 'AI Provider')],
         nodes=[('G01', 'Register Account'), ('G02', 'Sign In with Google'),
                ('G03', 'Search & Filter Products'), ('G04', 'View Product Details'),
                ('G05', 'View Product Reviews'), ('G06', 'View Collections & Banners'),
                ('G07', 'View FAQs & Content Pages'), ('G08', 'Manage Shopping Cart'),
                ('G10', 'Submit Contact Inquiry'), ('G11', 'Chat with AI Assistant'),
                ('G12', 'Request Live Staff Support'), ('G13', 'Virtual Try-On'),
                ('G14', 'Analyze Style Profile'), ('G15', 'Compare Products'), ('G16', 'View Recommendations')],
         others={'G09': 'Apply Coupon Code'},
         rel=[('extend', 'G08', 'G09')],
         ext=[('G02', 'Google'), ('G11', 'AI'), ('G13', 'AI'), ('G14', 'AI'), ('G15', 'AI')]),
    dict(name='Customer', system=STORE, actor='Customer',
         external=[('SePay', 'SePay')],
         nodes=[('K01', 'Manage Profile'), ('K02', 'Manage Address Book'),
                ('K03', 'Manage Wishlist'), ('K04', 'Place Order'),
                ('K08', 'Track Orders'), ('K09', 'Cancel Order'),
                ('K11', 'Request Return / Exchange'), ('K12', 'Submit Product Review'),
                ('K13', 'Edit / Delete My Review'), ('K14', 'View Notifications'),
                ('K15', 'Confirm Chatbot Action')],
         others={'K05': 'Make Payment', 'K06': 'Pay via COD', 'K07': 'Pay via VietQR Transfer',
                 'K10': 'Provide Refund Bank Account'},
         rel=[('include', 'K04', 'K05'), ('gen', 'K05', 'K06'), ('gen', 'K05', 'K07'), ('extend', 'K09', 'K10')],
         ext=[('K07', 'SePay')]),
    dict(name='Staff', system=ADMIN, actor='Staff', external=[],
         nodes=[('C01', 'View Profile & Permissions'), ('C02', 'View Internal Notifications'),
                ('C03', 'View Login History')],
         others={}, rel=[], ext=[]),
    dict(name='Sales & Support', system=ADMIN, actor='Sales & Support', external=[('AI', 'AI Provider')],
         nodes=[('S01', 'Look Up Products & Stock'), ('S02', 'View Orders'),
                ('S03', 'Confirm / Update Order Status'), ('S04', 'Cancel Order for Customer'),
                ('S05', 'Process Return Requests'), ('S06', 'Reply to Reviews'),
                ('S08', 'Handle Chatbot Inquiries'), ('S09', 'View Chatbot Logs (Masked PII)'),
                ('S10', 'Send Notification to Customer')],
         others={'S07': 'Draft Response with AI'},
         rel=[('extend', 'S06', 'S07')], ext=[('S07', 'AI')]),
    dict(name='Warehouse Staff', system=ADMIN, actor='Warehouse Staff', external=[],
         nodes=[('W01', 'View Products & Stock Levels'), ('W02', 'Create Goods Receipt Note'),
                ('W04', 'Adjust / Audit Stock'), ('W05', 'View Stock Movement Ledger'),
                ('W06', 'View Inventory Reports'), ('W07', 'Pack & Hand Over to Carrier'),
                ('W08', 'Receive Returned Goods')],
         others={'W03': 'Post Inbound Note (Add Stock)'},
         rel=[('extend', 'W02', 'W03')], ext=[]),
    dict(name='Accountant', system=ADMIN, actor='Accountant', external=[('SePay', 'SePay')],
         nodes=[('A01', 'View Orders'), ('A02', 'View Payment Transactions'),
                ('A03', 'Reconcile SePay Transactions'), ('A05', 'Manually Confirm Transfer'),
                ('A06', 'Create Refund Request'), ('A08', 'Execute Refund via QR Code'),
                ('A10', 'View Revenue Reports')],
         others={'A04': 'Manually Match Transaction', 'A07': 'Update Customer Refund Account',
                 'A09': 'Confirm Manual Transfer'},
         rel=[('extend', 'A03', 'A04'), ('extend', 'A06', 'A07'), ('extend', 'A08', 'A09')],
         ext=[('A03', 'SePay'), ('A08', 'SePay')]),
    dict(name='Marketing', system=ADMIN, actor='Marketing', external=[('AI', 'AI Provider')],
         nodes=[('T01', 'Manage Coupons & Vouchers'), ('T02', 'Manage Homepage Banners'),
                ('T03', 'Manage Collections'), ('T04', 'Send Campaigns to Customers'),
                ('T05', 'Draft Content with AI'), ('T06', 'Manage AI Knowledge Base'),
                ('T07', 'View Analytics Dashboard')],
         others={}, rel=[], ext=[('T05', 'AI'), ('T06', 'AI')]),
    dict(name='Store Manager', system=ADMIN, actor='Store Manager', external=[('AI', 'AI Provider')],
         nodes=[('M01', 'Manage Categories'), ('M02', 'Manage Attributes (Size, Color)'),
                ('M03', 'Manage Products & Variants'), ('M05', 'Publish / Hide Products'),
                ('M06', 'Moderate / Hide Reviews'), ('M08', 'View AI Operations Insights'),
                ('M09', 'View Employee Directory'), ('M10', 'View System Settings'),
                ('S01', 'Look Up Products & Stock'), ('S02', 'View Orders'),
                ('S03', 'Confirm / Update Order Status'), ('S04', 'Cancel Order for Customer'),
                ('S05', 'Process Return Requests'), ('S06', 'Reply to Reviews'),
                ('W02', 'Create Goods Receipt Note'), ('W04', 'Adjust / Audit Stock'),
                ('W05', 'View Stock Movement Ledger'), ('W06', 'View Inventory Reports'),
                ('A02', 'View Payment Transactions'), ('A10', 'View Revenue Reports'),
                ('T01', 'Manage Coupons & Vouchers'), ('T02', 'Manage Homepage Banners'),
                ('T03', 'Manage Collections'), ('T07', 'View Analytics Dashboard')],
         others={'M04': 'Generate Description with AI', 'M07': 'Review AI Moderation Flags',
                 'S07': 'Draft Response with AI', 'W03': 'Post Inbound Note (Add Stock)'},
         rel=[('extend', 'M03', 'M04'), ('extend', 'M06', 'M07'), ('extend', 'S06', 'S07'), ('extend', 'W02', 'W03')],
         ext=[('M04', 'AI'), ('M07', 'AI'), ('M08', 'AI'), ('S07', 'AI')]),
    dict(name='Administrator', system=ADMIN, actor='Administrator', external=[],
         nodes=[('D01', 'Manage Staff Accounts'), ('D03', 'Lock / Unlock Accounts'),
                ('D04', 'Manage Roles & Permissions'), ('D05', 'Assign Custom Permissions'),
                ('D06', 'View Audit Logs & Login History'), ('D07', 'Configure System Settings'),
                ('D08', 'Manage Locations & Shipping Rates'), ('D09', 'Toggle Payment Methods'),
                ('D10', 'Monitor AI Costs & Quotas')],
         others={'D02': 'Reset Staff Password'},
         rel=[('extend', 'D01', 'D02')], ext=[],
         note='Full Access (admin role = all permissions): In addition to the use cases here, administrators can perform all use cases of Store Manager, Sales & Support, Warehouse Staff, Accountant, and Marketing.'),
]

# ------------------------------------------------------------------ layout for single-actor page
def layout(d):
    names = dict(d['nodes']); names.update(d['others'])
    rels_of, ext_of = {}, {}
    for kind, base, other in d['rel']:
        rels_of.setdefault(base, []).append((kind, other))
    for uc, a in d['ext']:
        ext_of.setdefault(uc, []).append(a)
    occ = {c: [] for c in range(len(COL_X))}
    def free(c, y): return all(abs(y - o) >= P - 2 for o in occ[c])
    pos = {}

    def place_related(base):
        c, y = pos[base]
        cands0 = [y - P, y + P, y - 2 * P, y + 2 * P] if base in ext_of else [y, y + P, y - P, y + 2 * P]
        prev = None
        for k, (kind, other) in enumerate(rels_of.get(base, [])):
            cands = cands0 if k == 0 else [prev + P, prev - P, prev + 2 * P, prev - 2 * P]
            for cy in cands:
                if cy >= BOUND_Y + 50 and free(c + 1, cy): break
            else:
                raise RuntimeError(f'No space left for {other}')
            occ[c + 1].append(cy); pos[other] = (c + 1, cy); prev = cy
            place_related(other)

    cursor = {0: BOUND_Y + 60, 1: BOUND_Y + 60 + P // 2}
    for nid, _ in d['nodes']:
        c = 1 if (nid in rels_of or nid in ext_of) else (0 if cursor[0] <= cursor[1] else 1)
        y = cursor[c]
        while not free(c, y): y += P // 2
        occ[c].append(y); pos[nid] = (c, y); cursor[c] = y + P
        place_related(nid)

    maxc = max(c for c, _ in pos.values())
    maxy = max(y for _, y in pos.values())
    bound_r = COL_X[maxc] + UC_W + 40
    bound_b = maxy + UC_H / 2 + 40
    actor_cy = (BOUND_Y + bound_b) / 2

    def center(nid):
        c, y = pos[nid]
        return COL_X[c] + UC_W / 2, y

    # External actors placed cleanly to the right without orthogonal buses
    ext = {}
    links = {}
    for uc, a in d['ext']:
        links.setdefault(a, []).append(uc)
    order = sorted(links, key=lambda a: min(pos[u][1] for u in links[a]))
    for k, a in enumerate(order):
        ys = [pos[u][1] for u in links[a]]
        ext[a] = dict(cx=bound_r + 90, cy=(min(ys) + max(ys)) / 2, name=dict(d['external'])[a])
    ey = sorted(e['cy'] for e in ext.values())
    for i in range(1, len(ey)):
        assert ey[i] - ey[i - 1] >= 90, 'two external actors too close'
    return dict(names=names, pos=pos, center=center, actor=(ACTOR_CX, actor_cy), ext=ext,
                bound=(BOUND_X, BOUND_Y, bound_r, bound_b), rels_of=rels_of)

# ------------------------------------------------------------------ draw.io
def esc(s): return html.escape(s, quote=True)

class Page:
    def __init__(self, name):
        self.name, self.edges, self.vertices, self.n = name, [], [], 1
    def nid(self):
        self.n += 1; return f'c{self.n}'
    def vertex(self, value, style, x, y, w, h):
        vid = self.nid()
        self.vertices.append(f'<mxCell id="{vid}" value="{esc(value)}" style="{style}" vertex="1" parent="1">'
                             f'<mxGeometry x="{x:g}" y="{y:g}" width="{w}" height="{h}" as="geometry"/></mxCell>')
        return vid
    def edge(self, src, dst, style, points=(), value=''):
        eid = self.nid()
        pts = ''.join(f'<mxPoint x="{x:g}" y="{y:g}"/>' for x, y in points)
        arr = f'<Array as="points">{pts}</Array>' if pts else ''
        self.edges.append(f'<mxCell id="{eid}" value="{esc(value)}" style="{style}" edge="1" parent="1" source="{src}" target="{dst}">'
                          f'<mxGeometry relative="1" as="geometry">{arr}</mxGeometry></mxCell>')
    def xml(self, idx):
        body = ''.join(self.edges) + ''.join(self.vertices)
        return (f'<diagram id="page{idx}" name="{esc(self.name)}"><mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" '
                f'guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" '
                f'math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>{body}</root></mxGraphModel></diagram>')

S_ACTOR = 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;'
S_UC = 'ellipse;whiteSpace=wrap;html=1;fontSize=12;fillColor=#FFFFFF;'
S_NOTE = 'shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;size=14;align=left;verticalAlign=top;fontSize=11;spacing=6;'
NOTE_BOX = lambda L: (10, L['actor'][1] + 70, 160, 118)
S_BOUND = 'rounded=0;whiteSpace=wrap;html=1;fillColor=none;verticalAlign=top;fontStyle=1;fontSize=14;spacingTop=4;'
E = 'edgeStyle=none;html=1;rounded=0;'
E_ASSOC = E + 'endArrow=none;'
E_EXT = E + 'dashed=1;endArrow=open;endFill=0;fontSize=11;'
E_GEN = E + 'endArrow=block;endFill=0;'
def anchor(ex, en):
    m = {'l': 'X=0;{0}Y=0.5;', 'r': 'X=1;{0}Y=0.5;', 'b': 'X=0.5;{0}Y=1;', 't': 'X=0.5;{0}Y=0;'}
    return ('exit' + m[ex].format('exit') if ex else '') + ('entry' + m[en].format('entry') if en else '')

def build_page(d, L):
    p = Page(d['name'])
    bx, by, br, bb = L['bound']
    p.vertex(d['system'], S_BOUND, bx, by, br - bx, bb - by)
    ids = {}
    for nid in L['pos']:
        cx, cy = L['center'](nid)
        ids[nid] = p.vertex(L['names'][nid], S_UC, cx - UC_W / 2, cy - UC_H / 2, UC_W, UC_H)
    ax, ay = L['actor']
    actor = p.vertex(d['actor'], S_ACTOR, ax - ACT_W / 2, ay - ACT_H / 2, ACT_W, ACT_H)
    for a, e in L['ext'].items():
        ids[a] = p.vertex(e['name'], S_ACTOR, e['cx'] - ACT_W / 2, e['cy'] - ACT_H / 2, ACT_W, ACT_H)
    for nid, _ in d['nodes']:                       # fan of straight lines actor -> use case
        p.edge(actor, ids[nid], E_ASSOC)
    for kind, base, other in d['rel']:              # straight line between use cases
        if kind == 'extend':   p.edge(ids[other], ids[base], E_EXT, value='«extend»')
        elif kind == 'include': p.edge(ids[base], ids[other], E_EXT, value='«include»')
        else:                  p.edge(ids[other], ids[base], E_GEN)
    for uc, a in d['ext']:                          # external actor: direct straight line
        p.edge(ids[uc], ids[a], E_ASSOC + anchor('r', 'l'))
    if d.get('note'):                               # UML note attached to actor (dashed line, no arrow)
        nx, ny, nw, nh = NOTE_BOX(L)
        note = p.vertex(d['note'], S_NOTE, nx, ny, nw, nh)
        p.edge(note, actor, E + 'dashed=1;endArrow=none;' + anchor('t', 'b'))
    return p

# ------------------------------------------------------------------ page "Authentication & Actor Hierarchy"
AUTH = dict(
    actors={'Admin': ('Administrator', 520, 60), 'Manager': ('Store Manager', 520, 155),
            'Sales': ('Sales & Support', 520, 250), 'Warehouse': ('Warehouse Staff', 520, 345),
            'Accountant': ('Accountant', 520, 440), 'Marketing': ('Marketing', 520, 535),
            'Guest': ('Guest', 520, 700), 'Staff': ('Staff', 900, 297),
            'Customer': ('Customer', 900, 570), 'User': ('User', 1060, 430),
            'Mail': ('Email Service', 1670, 290)},
    gen=[('Admin', 'Staff'), ('Manager', 'Staff'), ('Sales', 'Staff'), ('Warehouse', 'Staff'),
         ('Accountant', 'Staff'), ('Marketing', 'Staff'), ('Staff', 'User'), ('Customer', 'User'), ('Customer', 'Guest')],
    bound=(1150, 40, 1570, 720), system='FITLY System (Storefront & Admin Portal)',
    ucs=[('U1', 'Log In', 1260, 150), ('U2', 'Forgot Password (Email OTP)', 1260, 290),
         ('U3', 'Change Password', 1260, 430), ('U4', 'Log Out', 1260, 570)],
    assoc=[('User', 'U1'), ('User', 'U2'), ('User', 'U3'), ('User', 'U4')],
    ext=[('U2', 'Mail')])

def build_auth():
    p = Page('Authentication & Actor Hierarchy')
    bx, by, br, bb = AUTH['bound']
    p.vertex(AUTH['system'], S_BOUND, bx, by, br - bx, bb - by)
    ids = {}
    for uid, name, cx, cy in AUTH['ucs']:
        ids[uid] = p.vertex(name, S_UC, cx - UC_W / 2, cy - UC_H / 2, UC_W, UC_H)
    for aid, (name, cx, cy) in AUTH['actors'].items():
        ids[aid] = p.vertex(name, S_ACTOR, cx - ACT_W / 2, cy - ACT_H / 2, ACT_W, ACT_H)
    for a, u in AUTH['assoc']: p.edge(ids[a], ids[u], E_ASSOC)
    for child, parent in AUTH['gen']: p.edge(ids[child], ids[parent], E_GEN)
    for u, a in AUTH['ext']: p.edge(ids[u], ids[a], E_ASSOC + anchor('r', 'l'))
    return p

# ------------------------------------------------------------------ PNG preview
try:
    FONT = ImageFont.truetype(r'C:\Windows\Fonts\arial.ttf', 13)
    FONT_B = ImageFont.truetype(r'C:\Windows\Fonts\arialbd.ttf', 14)
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
    r = 8
    dr.ellipse((cx - r, cy - 30, cx + r, cy - 30 + 2 * r), outline='black', fill='white')
    dr.line((cx, cy - 14, cx, cy + 8), fill='black'); dr.line((cx - 14, cy - 6, cx + 14, cy - 6), fill='black')
    dr.line((cx, cy + 8, cx - 12, cy + 30), fill='black'); dr.line((cx, cy + 8, cx + 12, cy + 30), fill='black')
    w = FONT.getlength(name); dr.text((cx - w / 2, cy + 34), name, fill='black', font=FONT)

def clip_ellipse(cx, cy, tx, ty):
    """point on ellipse perimeter (cx,cy,UC_W,UC_H) in direction towards (tx,ty)"""
    dx, dy = tx - cx, ty - cy
    a, b = UC_W / 2, UC_H / 2
    s = 1 / math.sqrt((dx / a) ** 2 + (dy / b) ** 2) if (dx or dy) else 0
    return cx + dx * s, cy + dy * s

def clip_rect(cx, cy, hw, hh, tx, ty):
    dx, dy = tx - cx, ty - cy
    s = min(hw / abs(dx) if dx else 9e9, hh / abs(dy) if dy else 9e9)
    return cx + dx * s, cy + dy * s

def dashed(dr, p1, p2, dash=6, gap=4):
    (x1, y1), (x2, y2) = p1, p2
    L = math.hypot(x2 - x1, y2 - y1)
    if L == 0: return
    ux, uy = (x2 - x1) / L, (y2 - y1) / L
    t = 0
    while t < L:
        e = min(t + dash, L)
        dr.line((x1 + ux * t, y1 + uy * t, x1 + ux * e, y1 + uy * e), fill='black'); t += dash + gap

def arrow_head(dr, tip, frm, kind):
    (tx, ty), (fx, fy) = tip, frm
    L = math.hypot(tx - fx, ty - fy); ux, uy = (tx - fx) / L, (ty - fy) / L; px, py = -uy, ux; s = 10
    a = (tx - ux * s + px * s * 0.55, ty - uy * s + py * s * 0.55)
    b = (tx - ux * s - px * s * 0.55, ty - uy * s - py * s * 0.55)
    if kind == 'open': dr.line((a, tip), fill='black'); dr.line((b, tip), fill='black')
    else: dr.polygon([tip, a, b], outline='black', fill='white')

def draw_uc(dr, cx, cy, name):
    dr.ellipse((cx - UC_W / 2, cy - UC_H / 2, cx + UC_W / 2, cy + UC_H / 2), outline='black', fill='white')
    lines = wrap(name, UC_W - 30, FONT)
    for k, ln in enumerate(lines):
        dr.text((cx - FONT.getlength(ln) / 2, cy - 8 * len(lines) + k * 16), ln, fill='black', font=FONT)

def label_mid(dr, p1, p2, text):
    mx, my = (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2
    tw = FONT_S.getlength(text)
    dr.rectangle((mx - tw / 2 - 2, my - 8, mx + tw / 2 + 2, my + 7), fill='white')
    dr.text((mx - tw / 2, my - 7), text, fill='black', font=FONT_S)

def preview_page(d, L, path):
    bx, by, br, bb = L['bound']
    W = int(br + 220); H = int(bb + 60)
    img = Image.new('RGB', (W, H), 'white'); dr = ImageDraw.Draw(img)
    dr.rectangle((bx, by, br, bb), outline='black')
    dr.text(((bx + br) / 2 - FONT_B.getlength(d['system']) / 2, by + 6), d['system'], fill='black', font=FONT_B)
    ax, ay = L['actor']
    for nid, _ in d['nodes']:
        cx, cy = L['center'](nid)
        dr.line((clip_rect(ax, ay, 15, 30, cx, cy), clip_ellipse(cx, cy, ax, ay)), fill='black')
    for kind, base, other in d['rel']:
        bc, oc = L['center'](base), L['center'](other)
        pb, po = clip_ellipse(*bc, *oc), clip_ellipse(*oc, *bc)
        if kind == 'extend':
            dashed(dr, po, pb); arrow_head(dr, pb, po, 'open'); label_mid(dr, po, pb, '«extend»')
        elif kind == 'include':
            dashed(dr, pb, po); arrow_head(dr, po, pb, 'open'); label_mid(dr, po, pb, '«include»')
        else:
            dr.line((po, pb), fill='black'); arrow_head(dr, pb, po, 'tri')
    for uc, a in d['ext']:
        cx, cy = L['center'](uc); e = L['ext'][a]
        dr.line(((cx + UC_W / 2, cy), (e['cx'] - ACT_W / 2, e['cy'])), fill='black')
    for nid in L['pos']:
        draw_uc(dr, *L['center'](nid), L['names'][nid])
    draw_actor(dr, ax, ay, d['actor'])
    for e in L['ext'].values(): draw_actor(dr, e['cx'], e['cy'], e['name'])
    if d.get('note'):
        nx, ny, nw, nh = NOTE_BOX(L)
        dashed(dr, (nx + nw / 2, ny), (ax, ay + ACT_H / 2 + 20))
        dr.polygon([(nx, ny), (nx + nw - 14, ny), (nx + nw, ny + 14), (nx + nw, ny + nh), (nx, ny + nh)], outline='black', fill='white')
        for k, ln in enumerate(wrap(d['note'], nw - 12, FONT_S)):
            dr.text((nx + 6, ny + 8 + k * 14), ln, fill='black', font=FONT_S)
    img.save(path)

def preview_auth(path):
    img = Image.new('RGB', (1800, 780), 'white'); dr = ImageDraw.Draw(img)
    bx, by, br, bb = AUTH['bound']
    dr.rectangle((bx, by, br, bb), outline='black')
    dr.text(((bx + br) / 2 - FONT_B.getlength(AUTH['system']) / 2, by + 6), AUTH['system'], fill='black', font=FONT_B)
    A = {k: (v[1], v[2]) for k, v in AUTH['actors'].items()}
    U = {u[0]: (u[2], u[3]) for u in AUTH['ucs']}
    for a, u in AUTH['assoc']:
        dr.line((clip_rect(*A[a], 15, 30, *U[u]), clip_ellipse(*U[u], *A[a])), fill='black')
    for child, parent in AUTH['gen']:
        p1 = clip_rect(*A[child], 15, 30, *A[parent]); p2 = clip_rect(*A[parent], 15, 30, *A[child])
        dr.line((p1, p2), fill='black'); arrow_head(dr, p2, p1, 'tri')
    for u, a in AUTH['ext']:
        dr.line(((U[u][0] + UC_W / 2, U[u][1]), (A[a][0] - 15, A[a][1])), fill='black')
    for uid, name, cx, cy in AUTH['ucs']: draw_uc(dr, cx, cy, name)
    for aid, (name, cx, cy) in AUTH['actors'].items(): draw_actor(dr, cx, cy, name)
    img.save(path)

# ------------------------------------------------------------------ main
if __name__ == '__main__':
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    for f in os.listdir(PREVIEW_DIR):
        os.remove(os.path.join(PREVIEW_DIR, f))
    pages = [build_auth()]
    preview_auth(os.path.join(PREVIEW_DIR, '0-authentication-actor-hierarchy.png'))
    for i, d in enumerate(PAGES, 1):
        L = layout(d)
        pages.append(build_page(d, L))
        slug = d['name'].lower().replace(' & ', '-').replace(' ', '-').replace('/', '-')
        preview_page(d, L, os.path.join(PREVIEW_DIR, f'{i}-{slug}.png'))
    xml = ('<mxfile host="app.diagrams.net" agent="fitly-usecase-generator" version="24.7.0">'
           + ''.join(p.xml(i) for i, p in enumerate(pages)) + '</mxfile>')
    out = os.path.join(OUT_DIR, 'FITLY-usecase.drawio')
    io.open(out, 'w', encoding='utf-8', newline='\n').write(xml)
    print('ok', out, len(pages), 'pages')
