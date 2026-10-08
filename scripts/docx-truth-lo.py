# m2fp.4: LibreOffice's reading of any .docx, as the DocxTruth JSON of
# test/helpers/docx-truth.ts, written beside it as <name>.lo.json. Tracked
# changes are COUNTED and then accepted (in memory only) so the paragraphs are
# the final text, as readDocx shows it. NOT run by npm test.
# Usage: <LibreOffice program>\python.exe scripts\docx-truth-lo.py <file.docx>...
import os, re, sys, json
import uno
from lo_common import Office, prop

CONTROL = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f]')


def clean(s):
    return CONTROL.sub('', (s or '').replace('\x0b', '\n').replace('\r', '\n'))


def count_enum(access):
    n, e = 0, access.createEnumeration()
    while e.hasMoreElements():
        e.nextElement(); n += 1
    return n


TAB_ALIGN = {'LEFT': 'left', 'CENTER': 'center', 'RIGHT': 'right', 'DECIMAL': 'decimal'}
TAB_LEADER = {' ': 'none', '.': 'dot', '-': 'hyphen', '_': 'underscore', '·': 'middleDot'}


def tabs_of(par):
    """(v9j3.1) ParaTabStops in points from the margin, rounded to a twip. A
    DEFAULT-aligned entry is LibreOffice's placeholder for 'default stops only'."""
    out = []
    for t in par.ParaTabStops:
        if t.Alignment.value == 'DEFAULT':
            continue
        out.append({'pos': round(t.Position * 72 / 2540 * 20) / 20, 'align': TAB_ALIGN.get(t.Alignment.value, t.Alignment.value),
                    'leader': TAB_LEADER.get(getattr(t.FillChar, 'value', t.FillChar), repr(t.FillChar))})
    return out


def segments(par):
    out, e = [], par.createEnumeration()
    while e.hasMoreElements():
        portion = e.nextElement()
        if portion.TextPortionType != 'Text':
            continue
        t = clean(portion.getString())
        if not t:
            continue
        seg = {'text': t, 'bold': portion.CharWeight >= 150, 'italic': portion.CharPosture.value != 'NONE',
               'sizePt': float(portion.CharHeight), 'font': portion.CharFontName}
        if out and all(out[-1][k] == seg[k] for k in ('bold', 'italic', 'sizePt', 'font')):
            out[-1]['text'] += t
        else:
            out.append(seg)
    return out


def links_of(par, links, state):
    e = par.createEnumeration()
    while e.hasMoreElements():
        portion = e.nextElement()
        url = portion.HyperLinkURL if portion.TextPortionType == 'Text' else ''
        t = clean(portion.getString())
        if url and state.get('url') == url:
            state['entry']['text'] += t
        elif url:
            entry = {'text': t, 'anchor': url[1:]} if url.startswith('#') else {'text': t, 'url': url}
            links.append(entry); state.clear(); state.update(url=url, entry=entry)
        else:
            state.clear()
    state.clear()


def cell_key(name):
    m = re.match(r'^([A-Z]+)(\d+)$', name)
    if not m:
        return (10 ** 9, 0)
    col = 0
    for ch in m.group(1):
        col = col * 26 + (ord(ch) - 64)
    return (int(m.group(2)), col)


CHAR_SPECIAL = 6   # com.sun.star.style.NumberingType: a bullet


def label_of(el):
    """The label LibreOffice displays. ListLabelString is EMPTY for a bullet, whose
    glyph lives in the level's BulletChar instead."""
    if not el.NumberingIsNumber:
        return None
    label = el.ListLabelString
    if not label:
        try:
            lvl = dict((pv.Name, pv.Value) for pv in el.NumberingRules.getByIndex(el.NumberingLevel))
            if lvl.get('NumberingType') == CHAR_SPECIAL:
                label = lvl.get('BulletChar') or ''
        except Exception:
            pass
    return label or None


def text_of(par):
    """Text and field portions only: getString() also carries a footnote's or an
    endnote's LABEL ('1', 'i'), which is an anchor, not text."""
    out, e = [], par.createEnumeration()
    while e.hasMoreElements():
        portion = e.nextElement()
        if portion.TextPortionType in ('Text', 'TextField'):
            out.append(portion.getString())
    return clean(''.join(out))


def walk(text, in_table, doc, paras, tables, links, top):
    e = text.createEnumeration()
    while e.hasMoreElements():
        el = e.nextElement()
        if el.supportsService('com.sun.star.text.Paragraph'):
            lvl = el.OutlineLevel
            try:
                style = doc.StyleFamilies.getByName('ParagraphStyles').getByName(el.ParaStyleName).DisplayName
            except Exception:
                style = el.ParaStyleName
            paras.append({'text': text_of(el), 'styleName': style,
                          'heading': lvl if 1 <= lvl <= 9 else None, 'listLabel': label_of(el),
                          'inTable': in_table, 'segments': segments(el), 'tabs': tabs_of(el)})
            links_of(el, links, {})
        elif el.supportsService('com.sun.star.text.TextTable'):
            names = sorted(el.getCellNames(), key=cell_key)
            rows = {}
            for n in names:
                sub = []
                walk(el.getCellByName(n), True, doc, sub, tables, links, False)
                paras.extend(sub)
                # A cell's text is its NON-EMPTY paragraphs, nested tables included:
                # a cell's getString() stops at a nested table.
                rows.setdefault(cell_key(n)[0], []).append('\n'.join(p['text'] for p in sub if p['text']))
            if top:
                tables.append({'rows': [rows[k] for k in sorted(rows)]})


def text_boxes(doc):
    n = 0
    for i in range(doc.DrawPage.getCount()):
        try:
            if doc.DrawPage.getByIndex(i).TextBox:
                n += 1
        except Exception:
            pass
    return n or doc.TextFrames.getCount()


def read(o, path):
    doc = o.desktop.loadComponentFromURL(uno.systemPathToFileUrl(os.path.abspath(path)), '_blank', 0, (prop('Hidden', True),))
    try:
        hdr = ftr = 0
        pstyles = doc.StyleFamilies.getByName('PageStyles')
        for name in pstyles.getElementNames():
            ps = pstyles.getByName(name)
            if not ps.isInUse():
                continue
            if ps.HeaderIsOn and ps.HeaderText.getString().strip():
                hdr += 1
            if ps.FooterIsOn and ps.FooterText.getString().strip():
                ftr += 1
        fields = comments = 0
        e = doc.TextFields.createEnumeration()
        while e.hasMoreElements():
            f = e.nextElement()
            if f.supportsService('com.sun.star.text.textfield.Annotation'):
                comments += 1
            elif not f.supportsService('com.sun.star.text.textfield.URL'):
                fields += 1
        fields += doc.DocumentIndexes.getCount()
        counts = {'headers': hdr, 'footers': ftr, 'footnotes': doc.Footnotes.getCount(), 'endnotes': doc.Endnotes.getCount(),
                  'textBoxes': text_boxes(doc), 'fields': fields, 'comments': comments, 'revisions': count_enum(doc.Redlines)}
        if counts['revisions']:
            disp = o.smgr.createInstanceWithContext('com.sun.star.frame.DispatchHelper', o.ctx)
            disp.executeDispatch(doc.CurrentController.Frame, '.uno:AcceptAllTrackedChanges', '', 0, ())
        def notes_of(coll):
            # v9j3.3.2: the anchor string is the mark LibreOffice displays; a
            # custom mark is the label.
            out = []
            for i in range(coll.getCount()):
                n = coll.getByIndex(i)
                out.append({'mark': n.getLabel() or n.getAnchor().getString(), 'text': clean(n.getString()).strip()})
            return out
        notes = {'footnotes': notes_of(doc.Footnotes), 'endnotes': notes_of(doc.Endnotes)}
        paras, tables, links = [], [], []
        walk(doc.Text, False, doc, paras, tables, links, True)
        return {'reader': 'LibreOffice ' + o.version(), 'paragraphs': paras, 'tables': tables, 'links': links,
                'images': doc.GraphicObjects.getCount(), 'counts': counts, 'notes': notes}
    finally:
        doc.close(True)


def main():
    with Office() as o:
        for path in sys.argv[1:]:
            truth = read(o, path)
            out = os.path.splitext(path)[0] + '.lo.json'
            with open(out, 'w', encoding='utf-8', newline='\n') as f:
                json.dump(truth, f, ensure_ascii=False, indent=2)
            print('wrote ' + out)


main()
