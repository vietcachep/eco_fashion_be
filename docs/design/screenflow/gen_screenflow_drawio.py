# -*- coding: utf-8 -*-
"""Generate FITLY screen-flow diagrams (draw.io + PNG) from the CURRENT front-end routes.

Sources of truth (read while writing this file):
  fashion_frontend_user  : src/app/**/page.tsx, src/lib/constants.ts (ROUTES), features/*/components (Link / router.push)
  fashion_frontend_admin : src/app/**/page.tsx, src/lib/constants.ts (SIDEBAR_NAV = platform, VENDOR_NAV = vendor,
                           landingScope / firstAllowedRoute), components/layout/route-guards.tsx

Outputs
  FITLY-screenflow.drawio                 one page per diagram
  preview/<n>-<slug>.png                  one PNG per diagram (validated before export)
  ../../../../docs-src/build/_flow_figs.json   ordered [{file, caption}] for the SRS build

Engine (layout / A* orthogonal routing / validator / renderer) lives in flow_engine.py.
Run:  python gen_screenflow_drawio.py
"""
import os, sys, json, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flow_engine import Diagram

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
PREVIEW_DIR = os.path.join(OUT_DIR, 'preview')
FIGS_JSON = os.path.abspath(os.path.join(OUT_DIR, '..', '..', '..', '..', 'docs-src', 'build', '_flow_figs.json'))

DIAGRAMS = []
def D(*a, **k):
    DIAGRAMS.append(Diagram(*a, **k))

# =====================================================================================================
# STOREFRONT (fashion_frontend_user)
# =====================================================================================================
D('storefront-browse-buy', 'Storefront - Browse and Buy',
  'Screen flow - Storefront: browse and buy',
  nodes=[
      ('start', 'Guest / customer', '', 'start', 0, 1),
      ('home', 'Home', '/', 'home', 1, 1),
      ('search', 'Search modal', 'header search', 'modal', 1, 0),
      ('plist', 'Product listing', '/products', 'screen', 2, 1),
      ('quick', 'Quick view', 'product card', 'modal', 2, 0),
      ('pd', 'Product detail', '/products/[slug]', 'screen', 3, 1),
      ('wish', 'Wishlist', '/wishlist', 'screen', 0, 2),
      ('shops', 'Shops', '/shops', 'screen', 1, 2),
      ('shop', 'Shop page', '/shop/[slug]', 'screen', 2, 2),
      ('cmp', 'Compare products', '/compare', 'screen', 3, 2),
      ('drawer', 'Cart drawer', 'header cart icon', 'modal', 4, 1),
      ('cart', 'Shopping cart', '/cart', 'screen', 5, 1),
      ('signed', 'Signed in?', 'decision', 'decision', 5, 2),
      ('login', 'Login', '/login?next=/checkout', 'ref', 4, 2),
      ('checkout', 'Checkout', '/checkout', 'screen', 5, 3),
      ('pay', 'Payment\nmethod?', '', 'decision', 5, 4.2),
      ('gate', 'PayOS gateway', 'hosted payment page', 'external', 5, 5.2),
      ('ret', 'PayOS return', '/checkout/payos-return', 'screen', 4, 5.2),
      ('ok', 'Order success', '/checkout/success/[code]', 'screen', 3, 4.2),
      ('orders', 'My orders', '/account/orders', 'ref', 2, 4.2),
  ],
  edges=[
      ('start', 'home', 'open site'),
      ('home', 'search', 'search'),
      ('search', 'plist', 'keyword / category'),
      ('home', 'plist', 'Shop menu'),
      ('plist', 'quick', 'quick view'),
      ('plist', 'pd', 'select'),
      ('quick', 'pd', 'view details'),
      ('home', 'wish', 'heart icon', 'bt'),
      ('home', 'shops', ''),
      ('shops', 'shop', 'open shop'),
      ('shop', 'pd', 'select'),
      ('pd', 'cmp', 'compare'),
      ('pd', 'drawer', 'add to cart'),
      ('drawer', 'cart', 'View cart'),
      ('cart', 'signed', 'Checkout'),
      ('signed', 'login', 'no', 'd'),
      ('login', 'checkout', 'after sign-in', 'bl'),
      ('signed', 'checkout', 'yes'),
      ('checkout', 'pay', 'Place order'),
      ('pay', 'gate', 'PayOS'),
      ('gate', 'ret', 'return'),
      ('ret', 'ok', 'paid'),
      ('pay', 'ok', 'COD'),
      ('ok', 'orders', 'view order'),
  ],
  groups=[
      ('Browse and discover', ['start', 'home', 'search', 'plist', 'quick', 'pd', 'wish', 'shops', 'shop', 'cmp']),
      ('Cart and checkout', ['drawer', 'cart', 'signed', 'login', 'checkout']),
      ('Payment and confirmation', ['pay', 'gate', 'ret', 'ok', 'orders']),
  ])

from flow_data_more import register
register(D)


def build_all():
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    for f in glob.glob(os.path.join(PREVIEW_DIR, '*.png')): os.remove(f)
    pages, figs, bad = [], [], False
    for i, d in enumerate(DIAGRAMS, 1):
        d.run()
        errs = d.validate()
        print(f'[{i}] {d.slug}: {len(d.nodes)} screens, {len(d.edges)} arrows, {d.W}x{d.H}, crossings={d.crossings}, '
              f'errors={len(errs)}, warnings={len(d.warns)}')
        for e in errs: print('   ERROR', e)
        for w in d.warns: print('   warn ', w)
        bad |= bool(errs)
        pages.append(d.drawio(i))
        fn = f'{i}-{d.slug}.png'
        if not errs or '--force' in sys.argv:
            d.png(os.path.join(PREVIEW_DIR, fn))
        figs.append(dict(file=os.path.join(PREVIEW_DIR, fn), caption=d.caption))
    if bad and '--force' not in sys.argv:
        print('VALIDATION FAILED - drawio / manifest not written'); sys.exit(1)
    xml = '<mxfile host="app.diagrams.net" agent="gen_screenflow_drawio.py" version="24.0.0">' + ''.join(pages) + '</mxfile>'
    open(os.path.join(OUT_DIR, 'FITLY-screenflow.drawio'), 'w', encoding='utf-8').write(xml)
    os.makedirs(os.path.dirname(FIGS_JSON), exist_ok=True)
    json.dump(figs, open(FIGS_JSON, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('OK', len(figs), 'diagrams ->', PREVIEW_DIR)


if __name__ == '__main__':
    build_all()
