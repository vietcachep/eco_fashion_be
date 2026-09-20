# -*- coding: utf-8 -*-
"""Generate FITLY-screenflow.drawio with 2 pages:
1. "Storefront Screen Flow" (Customer / Guest Web App - fashion_frontend_user)
2. "Admin Portal Screen Flow" (Employee / Admin Web App - fashion_frontend_admin)
Follows the hierarchical screen navigation flow format with root screen highlighted,
admin screens highlighted in green, and orthogonal connector lines with arrows.
Outputs FITLY-screenflow.drawio and high-res preview PNG images.
"""
import io, os, html, math
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
PREVIEW_DIR = os.path.join(OUT_DIR, 'preview')

# Box dimensions
BOX_W = 170
BOX_H = 42

# Style color definitions (hex and RGB)
PALETTE = {
    'root': {
        'drawio': 'fillColor=#FFF2CC;strokeColor=#D6B656;strokeWidth=1.5;fontStyle=1;',
        'bg': (255, 242, 204),
        'border': (214, 182, 86),
        'text': (0, 0, 0),
        'bold': True
    },
    'normal': {
        'drawio': 'fillColor=#FFFFFF;strokeColor=#333333;strokeWidth=1.2;',
        'bg': (255, 255, 255),
        'border': (60, 60, 60),
        'text': (0, 0, 0),
        'bold': False
    },
    'admin': {
        'drawio': 'fillColor=#D5E8D4;strokeColor=#82B366;strokeWidth=1.3;',
        'bg': (213, 232, 212),
        'border': (130, 179, 102),
        'text': (0, 0, 0),
        'bold': False
    },
    'modal': {
        'drawio': 'fillColor=#F5EEF8;strokeColor=#9673A6;strokeWidth=1.2;dashed=1;',
        'bg': (245, 238, 248),
        'border': (150, 115, 166),
        'text': (0, 0, 0),
        'bold': False
    },
    'external': {
        'drawio': 'fillColor=#F8CECC;strokeColor=#B85450;strokeWidth=1.2;',
        'bg': (248, 206, 204),
        'border': (184, 84, 80),
        'text': (0, 0, 0),
        'bold': False
    }
}

# -------------------------------------------------------------------------
# DATA: Storefront Screen Flow
# -------------------------------------------------------------------------
STOREFRONT_NODES = {
    # Entry Point (Root)
    'home': {'label': 'Home Page', 'col': 0, 'y': 520, 'type': 'root'},

    # Authentication & Customer Account Portal (Top Section)
    'login': {'label': 'Login Screen', 'col': 1, 'y': 140, 'type': 'normal'},
    'google_oauth': {'label': 'Google OAuth', 'col': 2, 'y': 60, 'type': 'external'},
    'register': {'label': 'Register Screen', 'col': 2, 'y': 120, 'type': 'normal'},
    'forgot_pwd': {'label': 'Forgot Password Screen', 'col': 2, 'y': 180, 'type': 'normal'},
    'reset_pwd': {'label': 'Reset Password (OTP)', 'col': 3, 'y': 180, 'type': 'modal'},
    'account_hub': {'label': 'Account Overview Hub', 'col': 2, 'y': 280, 'type': 'normal'},
    'profile': {'label': 'Profile Screen', 'col': 3, 'y': 240, 'type': 'normal'},
    'change_pwd': {'label': 'Change Password Modal', 'col': 4, 'y': 240, 'type': 'modal'},
    'addresses': {'label': 'Address Book Screen', 'col': 3, 'y': 300, 'type': 'normal'},
    'addr_modal': {'label': 'Add / Edit Address Modal', 'col': 4, 'y': 300, 'type': 'modal'},
    'my_reviews': {'label': 'My Reviews Screen', 'col': 3, 'y': 360, 'type': 'normal'},
    'review_modal': {'label': 'Edit / Delete Review', 'col': 4, 'y': 360, 'type': 'modal'},
    'cust_logout': {'label': 'Logout Action', 'col': 3, 'y': 420, 'type': 'modal'},

    # Product Discovery & Catalog (Center Section)
    'catalog': {'label': 'Product Catalog Screen', 'col': 1, 'y': 520, 'type': 'normal'},
    'filter_drawer': {'label': 'Filter & Search Drawer', 'col': 2, 'y': 480, 'type': 'modal'},
    'product_detail': {'label': 'Product Detail Screen', 'col': 2, 'y': 560, 'type': 'normal'},
    'variant_select': {'label': 'Variant Selector (Size/Color)', 'col': 3, 'y': 510, 'type': 'modal'},
    'size_chart': {'label': 'Size Chart Modal', 'col': 3, 'y': 560, 'type': 'modal'},
    'product_reviews': {'label': 'Customer Reviews Section', 'col': 3, 'y': 610, 'type': 'normal'},

    # Shopping Cart, Checkout & Order Tracking (Mid-Bottom Section)
    'cart': {'label': 'Shopping Cart Screen', 'col': 1, 'y': 710, 'type': 'normal'},
    'coupon_modal': {'label': 'Apply Coupon Modal', 'col': 2, 'y': 660, 'type': 'modal'},
    'checkout': {'label': 'Checkout Screen', 'col': 2, 'y': 740, 'type': 'normal'},
    'vnpay_gate': {'label': 'VNPay Payment Gateway', 'col': 3, 'y': 690, 'type': 'external'},
    'vnpay_return': {'label': 'VNPay Return Screen', 'col': 4, 'y': 690, 'type': 'normal'},
    'order_success': {'label': 'Order Success (VietQR / COD)', 'col': 3, 'y': 770, 'type': 'normal'},
    'orders_list': {'label': 'Order History Screen', 'col': 4, 'y': 770, 'type': 'normal'},
    'order_detail': {'label': 'Order Detail Screen', 'col': 5, 'y': 770, 'type': 'normal'},
    'cancel_order': {'label': 'Cancel Order Modal', 'col': 6, 'y': 730, 'type': 'modal'},
    'request_return': {'label': 'Request Return Modal', 'col': 6, 'y': 790, 'type': 'modal'},
    'refund_bank': {'label': 'Provide Refund Bank Account', 'col': 7, 'y': 790, 'type': 'modal'},

    # AI & Interactive Features
    'wishlist': {'label': 'Wishlist Screen', 'col': 1, 'y': 860, 'type': 'normal'},
    'compare': {'label': 'Compare Products Screen', 'col': 1, 'y': 920, 'type': 'normal'},
    'ai_style': {'label': 'AI Style Advisor Screen', 'col': 1, 'y': 980, 'type': 'normal'},
    'style_result': {'label': 'Style Profile & Suggestions', 'col': 2, 'y': 980, 'type': 'normal'},
    'virtual_tryon': {'label': 'Virtual Try-On Screen', 'col': 1, 'y': 1040, 'type': 'normal'},
    'tryon_result': {'label': 'Try-On Preview Result', 'col': 2, 'y': 1040, 'type': 'modal'},
    'ai_chatbot': {'label': 'AI Chatbot Widget', 'col': 1, 'y': 1110, 'type': 'normal'},
    'chatbot_advice': {'label': 'Product Consultation Modal', 'col': 2, 'y': 1100, 'type': 'modal'},
    'live_support': {'label': 'Request Live Support', 'col': 2, 'y': 1150, 'type': 'modal'},

    # Static & Support Information Pages (Bottom Section)
    'contact': {'label': 'Contact Us Screen', 'col': 1, 'y': 1210, 'type': 'normal'},
    'faq': {'label': 'FAQ & Help Center', 'col': 1, 'y': 1260, 'type': 'normal'},
    'policy': {'label': 'Policy & Terms Pages', 'col': 1, 'y': 1310, 'type': 'normal'},
}

STOREFRONT_EDGES = [
    # Auth & Account
    ('home', 'login'),
    ('login', 'google_oauth'),
    ('login', 'register'),
    ('login', 'forgot_pwd'),
    ('forgot_pwd', 'reset_pwd'),
    ('login', 'account_hub'),
    ('account_hub', 'profile'),
    ('profile', 'change_pwd'),
    ('account_hub', 'addresses'),
    ('addresses', 'addr_modal'),
    ('account_hub', 'my_reviews'),
    ('my_reviews', 'review_modal'),
    ('account_hub', 'cust_logout'),
    ('account_hub', 'orders_list'),

    # Catalog & Product Detail
    ('home', 'catalog'),
    ('catalog', 'filter_drawer'),
    ('catalog', 'product_detail'),
    ('product_detail', 'variant_select'),
    ('product_detail', 'size_chart'),
    ('product_detail', 'product_reviews'),
    ('product_detail', 'cart'),

    # Cart & Checkout & Order Lifecycle
    ('home', 'cart'),
    ('cart', 'coupon_modal'),
    ('cart', 'checkout'),
    ('checkout', 'vnpay_gate'),
    ('vnpay_gate', 'vnpay_return'),
    ('vnpay_return', 'order_success'),
    ('checkout', 'order_success'),
    ('order_success', 'orders_list'),
    ('orders_list', 'order_detail'),
    ('order_detail', 'cancel_order'),
    ('order_detail', 'request_return'),
    ('request_return', 'refund_bank'),

    # AI & Interactive
    ('home', 'wishlist'),
    ('wishlist', 'cart'),
    ('home', 'compare'),
    ('home', 'ai_style'),
    ('ai_style', 'style_result'),
    ('home', 'virtual_tryon'),
    ('virtual_tryon', 'tryon_result'),
    ('home', 'ai_chatbot'),
    ('ai_chatbot', 'chatbot_advice'),
    ('ai_chatbot', 'live_support'),

    # Support & Info
    ('home', 'contact'),
    ('home', 'faq'),
    ('home', 'policy'),
]

# -------------------------------------------------------------------------
# DATA: Admin Portal Screen Flow
# -------------------------------------------------------------------------
ADMIN_NODES = {
    # Entry Point (Root)
    'admin_login': {'label': 'Admin Login Screen', 'col': 0, 'y': 150, 'type': 'root'},

    # Authentication & Dashboard Hub
    'forgot_pwd': {'label': 'Forgot Password Screen', 'col': 1, 'y': 80, 'type': 'normal'},
    'reset_pwd': {'label': 'Reset Password (OTP)', 'col': 2, 'y': 80, 'type': 'modal'},
    'dashboard': {'label': 'Overview Admin Dashboard', 'col': 1, 'y': 220, 'type': 'normal'},
    'change_pwd': {'label': 'Change Password Screen', 'col': 2, 'y': 150, 'type': 'normal'},
    'admin_logout': {'label': 'Logout Action', 'col': 2, 'y': 210, 'type': 'modal'},

    # System Administration Hub (ADMIN RESTRICTED - Highlighted Green as in reference image)
    'admin_hub': {'label': 'System Admin Screen', 'col': 2, 'y': 350, 'type': 'admin'},
    'staff_users': {'label': 'Staff Accounts Screen', 'col': 3, 'y': 260, 'type': 'admin'},
    'create_staff': {'label': 'Create / Edit Staff Modal', 'col': 4, 'y': 235, 'type': 'admin'},
    'assign_roles': {'label': 'Assign Roles & Permissions', 'col': 4, 'y': 285, 'type': 'admin'},
    'roles_matrix': {'label': 'Roles & Permissions Matrix', 'col': 3, 'y': 335, 'type': 'admin'},
    'audit_logs': {'label': 'Audit Logs Screen', 'col': 3, 'y': 390, 'type': 'admin'},
    'audit_detail': {'label': 'Audit Log Detail Modal', 'col': 4, 'y': 390, 'type': 'admin'},
    'login_history': {'label': 'Login History Screen', 'col': 3, 'y': 445, 'type': 'admin'},
    'sys_settings': {'label': 'System Settings Screen', 'col': 3, 'y': 500, 'type': 'admin'},
    'shipping_rates': {'label': 'Shipping Rates & Provinces', 'col': 3, 'y': 555, 'type': 'admin'},
    'banner_manage': {'label': 'Homepage Banners Screen', 'col': 3, 'y': 610, 'type': 'admin'},

    # Product & Inventory Management (Warehouse / Catalog)
    'products_list': {'label': 'Product Management Screen', 'col': 2, 'y': 675, 'type': 'normal'},
    'create_product': {'label': 'Create Product Screen', 'col': 3, 'y': 660, 'type': 'normal'},
    'edit_product': {'label': 'Edit Product & Variants', 'col': 3, 'y': 710, 'type': 'normal'},
    'ai_copywriter': {'label': 'AI Description Generator', 'col': 4, 'y': 710, 'type': 'modal'},
    'inventory_stock': {'label': 'Inventory Stock Screen', 'col': 2, 'y': 770, 'type': 'normal'},
    'adjust_stock': {'label': 'Stock Adjustment Modal', 'col': 3, 'y': 770, 'type': 'modal'},
    'stock_history': {'label': 'Stock Movement Ledger', 'col': 4, 'y': 770, 'type': 'normal'},
    'inventory_receipts': {'label': 'Goods Receipts Screen', 'col': 2, 'y': 840, 'type': 'normal'},
    'create_receipt': {'label': 'Create Inbound Note Screen', 'col': 3, 'y': 840, 'type': 'normal'},
    'post_receipt': {'label': 'Post Receipt & Restock', 'col': 4, 'y': 840, 'type': 'modal'},

    # Orders & Returns Processing (Sales & CSKH)
    'orders_manage': {'label': 'Order Management Screen', 'col': 2, 'y': 920, 'type': 'normal'},
    'order_detail': {'label': 'Order Detail Screen', 'col': 3, 'y': 920, 'type': 'normal'},
    'update_status': {'label': 'Update Status Modal', 'col': 4, 'y': 895, 'type': 'modal'},
    'admin_cancel': {'label': 'Cancel Order Modal', 'col': 4, 'y': 945, 'type': 'modal'},
    'returns_manage': {'label': 'Returns Management Screen', 'col': 2, 'y': 1000, 'type': 'normal'},
    'return_detail': {'label': 'Return Request Detail Modal', 'col': 3, 'y': 1000, 'type': 'modal'},
    'restock_return': {'label': 'Approve Return & Restock', 'col': 4, 'y': 1000, 'type': 'modal'},

    # Payment & Accounting (Accountant)
    'payments_list': {'label': 'Payment Transactions Screen', 'col': 2, 'y': 1070, 'type': 'normal'},
    'payment_detail': {'label': 'Transaction Detail Modal', 'col': 3, 'y': 1070, 'type': 'modal'},
    'sepay_reconcile': {'label': 'SePay Reconcile Modal', 'col': 4, 'y': 1070, 'type': 'modal'},
    'refunds_list': {'label': 'Refund Requests Screen', 'col': 2, 'y': 1140, 'type': 'normal'},
    'create_refund': {'label': 'Create Refund Modal', 'col': 3, 'y': 1140, 'type': 'modal'},
    'qr_refund': {'label': 'Execute QR Refund Modal', 'col': 4, 'y': 1140, 'type': 'modal'},
    'payment_methods': {'label': 'Payment Methods Config', 'col': 2, 'y': 1200, 'type': 'normal'},

    # Catalog & Promotions (Marketing & Store Manager)
    'categories': {'label': 'Categories Screen', 'col': 2, 'y': 1260, 'type': 'normal'},
    'cat_tree': {'label': 'Category Tree Modal', 'col': 3, 'y': 1260, 'type': 'modal'},
    'attributes': {'label': 'Attributes (Size/Color) Screen', 'col': 2, 'y': 1315, 'type': 'normal'},
    'collections': {'label': 'Collections Screen', 'col': 2, 'y': 1365, 'type': 'normal'},
    'promotions': {'label': 'Promotions & Coupons Screen', 'col': 2, 'y': 1415, 'type': 'normal'},
    'create_voucher': {'label': 'Create Voucher Modal', 'col': 3, 'y': 1415, 'type': 'modal'},
    'reviews_manage': {'label': 'Reviews Moderation Screen', 'col': 2, 'y': 1475, 'type': 'normal'},
    'reply_review': {'label': 'Reply Review Modal (AI Draft)', 'col': 3, 'y': 1475, 'type': 'modal'},

    # AI Operations & Support (AI Hub)
    'ai_sessions': {'label': 'AI Chat Sessions Screen', 'col': 2, 'y': 1545, 'type': 'normal'},
    'session_transcript': {'label': 'Chat Transcript (Masked PII)', 'col': 3, 'y': 1545, 'type': 'normal'},
    'ai_docs': {'label': 'AI Knowledge Base Screen', 'col': 2, 'y': 1605, 'type': 'normal'},
    'upload_doc': {'label': 'Upload Document / FAQ Modal', 'col': 3, 'y': 1605, 'type': 'modal'},
    'ai_moderation': {'label': 'AI Moderation Queue Screen', 'col': 2, 'y': 1665, 'type': 'normal'},
    'review_flags': {'label': 'Review Flagged Content Modal', 'col': 3, 'y': 1665, 'type': 'modal'},
    'ai_support': {'label': 'Chatbot Support Tickets Screen', 'col': 2, 'y': 1720, 'type': 'normal'},
    'ai_insights': {'label': 'AI Business Insights Screen', 'col': 2, 'y': 1770, 'type': 'normal'},
    'ai_usage': {'label': 'AI Costs & Quotas Screen', 'col': 2, 'y': 1820, 'type': 'normal'},

    # Reporting & Analytics
    'rep_revenue': {'label': 'Revenue Analytics Screen', 'col': 2, 'y': 1885, 'type': 'normal'},
    'rep_inventory': {'label': 'Inventory Reports Screen', 'col': 2, 'y': 1935, 'type': 'normal'},
    'rep_top_products': {'label': 'Top Selling Products Screen', 'col': 2, 'y': 1985, 'type': 'normal'},
}

ADMIN_EDGES = [
    # Auth & Topbar
    ('admin_login', 'forgot_pwd'),
    ('forgot_pwd', 'reset_pwd'),
    ('admin_login', 'dashboard'),
    ('dashboard', 'change_pwd'),
    ('dashboard', 'admin_logout'),

    # System Admin (Green)
    ('dashboard', 'admin_hub'),
    ('admin_hub', 'staff_users'),
    ('staff_users', 'create_staff'),
    ('staff_users', 'assign_roles'),
    ('admin_hub', 'roles_matrix'),
    ('admin_hub', 'audit_logs'),
    ('audit_logs', 'audit_detail'),
    ('admin_hub', 'login_history'),
    ('admin_hub', 'sys_settings'),
    ('admin_hub', 'shipping_rates'),
    ('admin_hub', 'banner_manage'),

    # Product & Stock
    ('dashboard', 'products_list'),
    ('products_list', 'create_product'),
    ('products_list', 'edit_product'),
    ('edit_product', 'ai_copywriter'),
    ('dashboard', 'inventory_stock'),
    ('inventory_stock', 'adjust_stock'),
    ('inventory_stock', 'stock_history'),
    ('dashboard', 'inventory_receipts'),
    ('inventory_receipts', 'create_receipt'),
    ('inventory_receipts', 'post_receipt'),

    # Orders & Returns
    ('dashboard', 'orders_manage'),
    ('orders_manage', 'order_detail'),
    ('order_detail', 'update_status'),
    ('order_detail', 'admin_cancel'),
    ('dashboard', 'returns_manage'),
    ('returns_manage', 'return_detail'),
    ('return_detail', 'restock_return'),

    # Payments & Cashier
    ('dashboard', 'payments_list'),
    ('payments_list', 'payment_detail'),
    ('payment_detail', 'sepay_reconcile'),
    ('dashboard', 'refunds_list'),
    ('refunds_list', 'create_refund'),
    ('refunds_list', 'qr_refund'),
    ('dashboard', 'payment_methods'),

    # Catalog & Promotions
    ('dashboard', 'categories'),
    ('categories', 'cat_tree'),
    ('dashboard', 'attributes'),
    ('dashboard', 'collections'),
    ('dashboard', 'promotions'),
    ('promotions', 'create_voucher'),
    ('dashboard', 'reviews_manage'),
    ('reviews_manage', 'reply_review'),

    # AI Operations
    ('dashboard', 'ai_sessions'),
    ('ai_sessions', 'session_transcript'),
    ('dashboard', 'ai_docs'),
    ('ai_docs', 'upload_doc'),
    ('dashboard', 'ai_moderation'),
    ('ai_moderation', 'review_flags'),
    ('dashboard', 'ai_support'),
    ('dashboard', 'ai_insights'),
    ('dashboard', 'ai_usage'),

    # Reports
    ('dashboard', 'rep_revenue'),
    ('dashboard', 'rep_inventory'),
    ('dashboard', 'rep_top_products'),
]

# -------------------------------------------------------------------------
# DRAW.IO XML GENERATOR
# -------------------------------------------------------------------------
def esc(s):
    return html.escape(str(s), quote=True)

class DrawioDiagram:
    def __init__(self, name, width, height):
        self.name = name
        self.width = width
        self.height = height
        self.vertices = []
        self.edges = []
        self.counter = 10

    def add_vertex(self, vid, label, x, y, w, h, style):
        xml = (f'<mxCell id="{vid}" value="{esc(label)}" style="{style}" vertex="1" parent="1">'
               f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
        self.vertices.append(xml)

    def add_edge(self, eid, src, dst, style):
        xml = (f'<mxCell id="{eid}" value="" style="{style}" edge="1" parent="1" source="{src}" target="{dst}">'
               f'<mxGeometry relative="1" as="geometry"/></mxCell>')
        self.edges.append(xml)

    def to_xml(self, page_id):
        content = ''.join(self.edges) + ''.join(self.vertices)
        return (f'<diagram id="{page_id}" name="{esc(self.name)}">'
                f'<mxGraphModel dx="1600" dy="1000" grid="1" gridSize="10" guides="1" tooltips="1" '
                f'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{self.width}" '
                f'pageHeight="{self.height}" math="0" shadow="0">'
                f'<root><mxCell id="0"/><mxCell id="1" parent="0"/>{content}</root></mxGraphModel></diagram>')

def build_drawio_diagram(title, nodes, edges, col_coords, page_id, diagram_w, diagram_h):
    diag = DrawioDiagram(title, diagram_w, diagram_h)

    # 1. System Outer Boundary
    boundary_style = ('rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#444444;'
                      'strokeWidth=1.5;verticalAlign=top;align=center;fontStyle=1;fontSize=15;spacingTop=10;')
    diag.add_vertex('sys_bound', f'FITLY — {title}', 20, 20, diagram_w - 40, diagram_h - 40, boundary_style)

    # 2. Add Screen Vertices
    for nid, data in nodes.items():
        x = col_coords[data['col']]
        y = data['y']
        style_info = PALETTE[data['type']]
        cell_style = f'rounded=0;whiteSpace=wrap;html=1;fontSize=11;{style_info["drawio"]}'
        diag.add_vertex(nid, data['label'], x, y, BOX_W, BOX_H, cell_style)

    # 3. Add Edges (Orthogonal with Arrow)
    edge_style = ('edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;'
                  'endArrow=classic;endFill=1;strokeColor=#333333;strokeWidth=1.2;')
    for i, (src, dst) in enumerate(edges):
        diag.add_edge(f'e_{src}_{dst}_{i}', src, dst, edge_style)

    return diag.to_xml(page_id)

# -------------------------------------------------------------------------
# PNG PREVIEW GENERATOR (PIL)
# -------------------------------------------------------------------------
try:
    FONT = ImageFont.truetype(r'C:\Windows\Fonts\arial.ttf', 11)
    FONT_B = ImageFont.truetype(r'C:\Windows\Fonts\arialbd.ttf', 11)
    FONT_TITLE = ImageFont.truetype(r'C:\Windows\Fonts\arialbd.ttf', 16)
except Exception:
    FONT = FONT_B = FONT_TITLE = ImageFont.load_default()

def wrap_text(text, max_px, font):
    words = text.split()
    lines, cur = [], ''
    for w in words:
        cand = (cur + ' ' + w).strip()
        if font.getlength(cand) <= max_px:
            cur = cand
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

def render_preview(title, nodes, edges, col_coords, out_png, img_w, img_h):
    img = Image.new('RGB', (img_w, img_h), (255, 255, 255))
    dr = ImageDraw.Draw(img)

    # 1. Outer System Boundary
    dr.rectangle((20, 20, img_w - 20, img_h - 20), outline=(80, 80, 80), width=2)
    title_text = f'FITLY — {title}'
    tw = FONT_TITLE.getlength(title_text)
    dr.text(((img_w - tw) / 2, 28), title_text, fill=(30, 30, 30), font=FONT_TITLE)

    # Calculate coordinates for nodes
    pos = {}
    for nid, data in nodes.items():
        x = col_coords[data['col']]
        y = data['y']
        pos[nid] = (x, y)

    # 2. Draw Orthogonal Connector Lines with Arrows
    arrow_size = 6
    for src, dst in edges:
        if src not in pos or dst not in pos:
            continue
        sx, sy = pos[src]
        dx, dy = pos[dst]

        # Standard left-to-right flow: from right center of src to left center of dst
        if dx > sx:
            start_pt = (sx + BOX_W, sy + BOX_H // 2)
            end_pt = (dx, dy + BOX_H // 2)
            mid_x = (start_pt[0] + end_pt[0]) // 2

            # 3-segment orthogonal line: horizontal -> vertical -> horizontal
            dr.line([start_pt, (mid_x, start_pt[1]), (mid_x, end_pt[1]), end_pt], fill=(60, 60, 60), width=1)

            # Arrow tip pointing right
            tip_x, tip_y = end_pt
            arrow_poly = [
                (tip_x, tip_y),
                (tip_x - arrow_size - 2, tip_y - arrow_size),
                (tip_x - arrow_size - 2, tip_y + arrow_size)
            ]
            dr.polygon(arrow_poly, fill=(60, 60, 60))

        # Vertical or downward connection (if in same column or backward)
        elif dx == sx:
            if dy > sy:
                start_pt = (sx + BOX_W // 2, sy + BOX_H)
                end_pt = (dx + BOX_W // 2, dy)
                dr.line([start_pt, end_pt], fill=(60, 60, 60), width=1)
                tip_x, tip_y = end_pt
                arrow_poly = [
                    (tip_x, tip_y),
                    (tip_x - arrow_size, tip_y - arrow_size - 2),
                    (tip_x + arrow_size, tip_y - arrow_size - 2)
                ]
                dr.polygon(arrow_poly, fill=(60, 60, 60))
        else:
            # Right-to-left loop (fallback)
            start_pt = (sx, sy + BOX_H // 2)
            end_pt = (dx + BOX_W, dy + BOX_H // 2)
            mid_x = (start_pt[0] + end_pt[0]) // 2
            dr.line([start_pt, (mid_x, start_pt[1]), (mid_x, end_pt[1]), end_pt], fill=(60, 60, 60), width=1)
            tip_x, tip_y = end_pt
            arrow_poly = [
                (tip_x, tip_y),
                (tip_x + arrow_size + 2, tip_y - arrow_size),
                (tip_x + arrow_size + 2, tip_y + arrow_size)
            ]
            dr.polygon(arrow_poly, fill=(60, 60, 60))

    # 3. Draw Screen Boxes (Drawn after lines so boxes cleanly overlay line origins)
    for nid, data in nodes.items():
        x, y = pos[nid]
        style = PALETTE[data['type']]
        fnt = FONT_B if style['bold'] else FONT

        # Fill & Border
        dr.rectangle((x, y, x + BOX_W, y + BOX_H), fill=style['bg'], outline=style['border'], width=2 if style['bold'] else 1)

        # Centered Text with line wrap
        lines = wrap_text(data['label'], BOX_W - 14, fnt)
        total_text_h = len(lines) * 14
        start_y = y + (BOX_H - total_text_h) // 2

        for k, line in enumerate(lines):
            lw = fnt.getlength(line)
            dr.text((x + (BOX_W - lw) // 2, start_y + k * 14), line, fill=style['text'], font=fnt)

    img.save(out_png)
    print(f'Generated preview: {out_png}')

# -------------------------------------------------------------------------
# MAIN
# -------------------------------------------------------------------------
if __name__ == '__main__':
    os.makedirs(PREVIEW_DIR, exist_ok=True)

    # 1. Storefront Screen Flow Setup
    # Column X coordinates
    sf_cols = [50, 270, 490, 710, 930, 1150, 1370, 1590]
    sf_w = 1800
    sf_h = 1390

    sf_xml = build_drawio_diagram(
        'Storefront Screen Flow',
        STOREFRONT_NODES,
        STOREFRONT_EDGES,
        sf_cols,
        'page1_storefront',
        sf_w,
        sf_h
    )
    render_preview(
        'Storefront Screen Flow',
        STOREFRONT_NODES,
        STOREFRONT_EDGES,
        sf_cols,
        os.path.join(PREVIEW_DIR, '1-storefront-screenflow.png'),
        sf_w,
        sf_h
    )

    # 2. Admin Portal Screen Flow Setup
    admin_cols = [50, 270, 490, 710, 930]
    admin_w = 1160
    admin_h = 2070

    admin_xml = build_drawio_diagram(
        'Admin Portal Screen Flow',
        ADMIN_NODES,
        ADMIN_EDGES,
        admin_cols,
        'page2_admin',
        admin_w,
        admin_h
    )
    render_preview(
        'Admin Portal Screen Flow',
        ADMIN_NODES,
        ADMIN_EDGES,
        admin_cols,
        os.path.join(PREVIEW_DIR, '2-admin-portal-screenflow.png'),
        admin_w,
        admin_h
    )

    # 3. Combine into single FITLY-screenflow.drawio
    full_drawio = (
        '<mxfile host="app.diagrams.net" agent="fitly-screenflow-generator" version="24.7.0">'
        + sf_xml + admin_xml +
        '</mxfile>'
    )
    out_drawio = os.path.join(OUT_DIR, 'FITLY-screenflow.drawio')
    io.open(out_drawio, 'w', encoding='utf-8', newline='\n').write(full_drawio)
    print(f'Successfully generated: {out_drawio}')
