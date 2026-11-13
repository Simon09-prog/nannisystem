"""Baut die Speisekarte aus menu.json.

- schreibt die Akkordeon-Karte in index.html (zwischen <!-- MENU:START --> und <!-- MENU:END -->)
- erzeugt karte.html, die eigenstaendige Kartenseite fuer QR-Code/NFC am Tisch

Aufruf: python build_menu.py   (nach jeder Aenderung an menu.json)
"""
import html
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
menu = json.load(open(os.path.join(HERE, "menu.json"), encoding="utf-8"))
cats = menu["kategorien"]

# Kategorien ohne Foto bekommen ein Linien-Icon (Symbole stehen in beiden Seiten im <defs>-Block)
ICON = {"favourites": "i-iced", "fresh": "i-citrus", "soft": "i-bottle", "fruehstueck": "i-egg",
        "bowls": "i-bowl", "bagels": "i-bagel", "waffeln": "i-waffle"}
# Markierung -> (CSS-Klasse, Text, Icon)
TAG = {"vegan": ("tag-vegan", "vegan", "i-leaf"), "veggie": ("tag-veggie", "veggie", "i-leaf"),
       "vegan-opt": ("tag-vegan", "vegan möglich", "i-leaf"), "scharf": ("tag-hot", "scharf", "i-chili")}
ADDONS = menu.get("addons", [])

e = lambda s: html.escape(s, quote=True)


def price_num(p):
    return float(p.replace(",", "."))


def cents(p):
    """Preis in Cent."""
    return round(price_num(p) * 100)


def thumb(c, size):
    if c.get("img"):
        return f'<span class="cat-thumb"><img src="{c["img"]}" alt="" loading="lazy" width="{size}" height="{size}"></span>'
    return f'<span class="cat-thumb cat-icon"><svg aria-hidden="true"><use href="#{ICON.get(c["id"], "i-cup")}"/></svg></span>'


def groups(c):
    """Kategorie als Liste von (Ueberschrift, Positionen); ohne Untergruppen eine Gruppe ohne Titel."""
    return [(g["title"], g["items"]) for g in c["groups"]] if c.get("groups") else [(None, c["items"])]


def all_items(c):
    return [it for _, items in groups(c) for it in items]


def item_html(it):
    marks = ""
    for t in it.get("tags", []):
        cls, label, icon = TAG[t]
        marks += f' <span class="tag {cls}"><svg aria-hidden="true"><use href="#{icon}"/></svg>{label}</span>'
    if it.get("badge"):
        marks += f' <span class="tag tag-badge">{e(it["badge"])}</span>'
    desc = f'<p>{e(it["desc"])}</p>' if it.get("desc") else ""
    return (f'<li class="mi" data-n="{e(it["name"])}" data-p="{cents(it["price"])}"><div class="mi-top"><h4>{e(it["name"])}{marks}</h4>'
            f'<span class="mi-line" aria-hidden="true"></span><span class="mi-price">{it["price"]}&nbsp;€</span></div>{desc}</li>')


def body_html(c):
    out = ""
    if c.get("callout"):
        out += (f'<div class="callout"><b>{e(c["callout"]["title"])}</b><p>{e(c["callout"]["text"])}</p></div>')
    for title, items in groups(c):
        if title:
            out += f'<h5 class="mi-group">{e(title)}</h5>'
        out += '<ul class="mi-list">' + "".join(item_html(it) for it in items) + "</ul>"
    blocks = list(c.get("extras", []))
    if c.get("addons"):
        blocks.append({"title": "Add-ons", "items": ADDONS})
    for b in blocks:
        out += (f'<div class="extras"><b>{e(b["title"])}</b><ul>'
                + "".join(f'<li data-n="{e(n)}" data-p="{cents(p)}">{e(n)} <span>+{p}&nbsp;€</span></li>' for n, p in b["items"]) + "</ul></div>")
    if c.get("notes"):
        out += '<ul class="cat-notes">' + "".join(f"<li>{e(n)}</li>" for n in c["notes"]) + "</ul>"
    return out


# ---------- 1) Akkordeon fuer index.html ----------
acc = []
for i, c in enumerate(cats):
    low = min(price_num(it["price"]) for it in all_items(c))
    low_s = f"{low:.2f}".replace(".", ",")
    acc.append(
        f'<details class="cat" name="karte" id="k-{c["id"]}"{" open" if i == 0 else ""}>'
        f'<summary>{thumb(c, 56)}<span class="cat-title"><b>{e(c["name"])}</b><small>{e(c["sub"])}</small></span>'
        f'<span class="cat-meta">ab {low_s}&nbsp;€</span><span class="cat-plus" aria-hidden="true"></span></summary>'
        f'<div class="cat-body">{body_html(c)}</div></details>'
    )
fragment = "\n".join(acc)

idx_path = os.path.join(HERE, "index.html")
idx = open(idx_path, encoding="utf-8").read()
idx, n = re.subn(r"(<!-- MENU:START -->).*?(<!-- MENU:END -->)", lambda m: m.group(1) + "\n" + fragment + "\n" + m.group(2), idx, flags=re.S)
assert n == 1, "Marker in index.html nicht gefunden"
open(idx_path, "w", encoding="utf-8").write(idx)

# ---------- 2) karte.html ----------
chips = "".join(f'<a href="#{c["id"]}">{e(c.get("short", c["name"]))}</a>' for c in cats)
sections = "".join(
    f'<section class="kcat" id="{c["id"]}"><header class="kcat-head">{thumb(c, 64)}'
    f'<div><h2>{e(c["name"])}</h2><p>{e(c["sub"])}</p></div></header>{body_html(c)}</section>'
    for c in cats
)

ld = {
    "@context": "https://schema.org",
    "@type": "Menu",
    "name": "Speisekarte NANNI Coffee & Bar",
    "inLanguage": "de",
    "hasMenuSection": [
        {
            "@type": "MenuSection",
            "name": c["name"],
            "hasMenuItem": [
                {k: v for k, v in {
                    "@type": "MenuItem",
                    "name": it["name"],
                    "description": it.get("desc"),
                    "suitableForDiet": {"vegan": "https://schema.org/VeganDiet", "veggie": "https://schema.org/VegetarianDiet"}.get((it.get("tags") or [None])[0]),
                    "offers": {"@type": "Offer", "price": f'{price_num(it["price"]):.2f}', "priceCurrency": "EUR"},
                }.items() if v}
                for it in all_items(c)
            ],
        }
        for c in cats
    ],
}

tpl = open(os.path.join(HERE, "karte.template.html"), encoding="utf-8").read()
page = (tpl.replace("{{CHIPS}}", chips)
           .replace("{{SECTIONS}}", sections)
           .replace("{{STAND}}", e(menu["stand"]))
           .replace("{{JSONLD}}", json.dumps(ld, ensure_ascii=False, indent=1)))
open(os.path.join(HERE, "karte.html"), "w", encoding="utf-8").write(page)

print(f"{len(cats)} Kategorien, {sum(len(all_items(c)) for c in cats)} Positionen -> index.html + karte.html")
