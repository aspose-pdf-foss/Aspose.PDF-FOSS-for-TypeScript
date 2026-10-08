# m2fp.4: builds the five LibreOffice-written corpus documents through UNO.
# Usage: <LibreOffice program>\python.exe scripts\gen-docx-corpus-lo.py <outdir>
# NOT run by npm test. The recipes mirror scripts/gen-docx-corpus-word.ps1 text
# for text; keep the two in step — except notes (v9j3.3.2): LibreOffice numbers
# footnotes document-wide, so this file exercises format + start where Word's
# restarts per section. An optional second argument builds one topic.
import os, sys, struct, zlib, tempfile
import uno
from lo_common import Office, prop
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK
from com.sun.star.awt.FontWeight import BOLD
from com.sun.star.awt.FontSlant import ITALIC
from com.sun.star.text.TextContentAnchorType import AS_CHARACTER, AT_PARAGRAPH
from com.sun.star.style.NumberingType import ARABIC, CHARS_LOWER_LETTER, ROMAN_LOWER

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures', 'docx'))
MANAGED = ('CharWeight', 'CharPosture', 'CharHeight', 'CharFontName', 'CharColor', 'CharStyleName', 'HyperLinkURL')
PARA_RESET = ('PageDescName', 'ParaIsNumberingRestart', 'NumberingStartValue')


def png16(path):
    raw = b''.join(b'\x00' + bytes(v for x in range(16) for v in (x * 16, y * 16, 128)) for y in range(16))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 16, 16, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def size(w, h):
    s = uno.createUnoStruct('com.sun.star.awt.Size')
    s.Width, s.Height = w, h
    return s


class Writer:
    def __init__(self, office):
        self.o = office
        self.doc = office.desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, (prop('Hidden', True),))
        self.text = self.doc.Text
        self.cur = self.text.createTextCursor()
        self.first = True

    def _break(self):
        if not self.first:
            self.text.insertControlCharacter(self.cur, PARAGRAPH_BREAK, False)
        self.first = False
        for n in PARA_RESET:
            try:
                self.cur.setPropertyToDefault(n)
            except Exception:
                pass

    def para(self, style, runs, numbering='', level=0, restart=False, page=None):
        """A paragraph: style, runs (str or (text, {props})), optional list style and level."""
        self._break()
        self.cur.ParaStyleName = style
        self.cur.NumberingStyleName = numbering
        if numbering:
            self.cur.NumberingLevel = level
            if restart:
                self.cur.ParaIsNumberingRestart = True
                self.cur.NumberingStartValue = 1   # without it the restart counts from 0
        if page:
            self.cur.PageDescName = page
        for r in runs:
            if isinstance(r, str):
                self.run(r)
            else:
                self.run(r[0], **r[1])

    def run(self, text, **props):
        self.cur.setPropertiesToDefault(MANAGED)
        self.text.insertString(self.cur, text, False)
        if props:
            self.cur.goLeft(len(text), True)
            for k, v in props.items():
                self.cur.setPropertyValue(k, v)
            self.cur.collapseToEnd()

    def block(self, content):
        """A table or an index, in a paragraph of its own; the next para() reuses the one after it."""
        self._break()
        self.text.insertTextContent(self.cur, content, False)
        self.first = True

    def save(self, name):
        path = os.path.join(OUT, name)
        if os.path.exists(path):
            os.remove(path)
        self.doc.storeToURL(uno.systemPathToFileUrl(path), (prop('FilterName', 'MS Word 2007 XML'), prop('Overwrite', True)))
        self.doc.close(True)
        print('wrote ' + path)


def styles_doc(o, tag):
    w = Writer(o)
    fams = w.doc.StyleFamilies
    pst, cst = fams.getByName('ParagraphStyles'), fams.getByName('CharacterStyles')
    ch = w.doc.createInstance('com.sun.star.style.ParagraphStyle'); pst.insertByName('Custom Heading', ch); ch.ParentStyle = 'Heading 2'
    sc = w.doc.createInstance('com.sun.star.style.CharacterStyle'); cst.insertByName('Strong Custom', sc); sc.CharWeight = BOLD
    bp = w.doc.createInstance('com.sun.star.style.ParagraphStyle'); pst.insertByName('Bold Para', bp); bp.ParentStyle = 'Standard'; bp.CharWeight = BOLD
    w.para('Heading 1', ['Styles and headings'])
    w.para('Heading 2', ['Second level'])
    w.para('Heading 3', ['Third level'])
    w.para('Custom Heading', ['Custom heading text'])
    w.para('Standard', ['Plain body text.'])
    w.para('Standard', [('Direct ', {'CharWeight': BOLD}), ('formats ', {'CharPosture': ITALIC}), ('sizes ', {'CharHeight': 16.0}),
                        ('fonts ', {'CharFontName': 'Courier New'}), ('colours ', {'CharColor': 0xFF0000}), 'end.'])
    w.para('Standard', ['A ', ('strong ', {'CharStyleName': 'Strong Custom'}), 'word.'])
    w.para('Bold Para', [('toggle ', {'CharStyleName': 'Strong Custom'}), 'rest.'])
    w.save('lo%s-styles.docx' % tag)


def lists_doc(o, tag):
    w = Writer(o)
    nst = w.doc.StyleFamilies.getByName('NumberingStyles')
    ml = w.doc.createInstance('com.sun.star.style.NumberingStyle'); nst.insertByName('Corpus Multilevel', ml)
    rules = ml.NumberingRules
    for lvl, ntype in enumerate((ARABIC, CHARS_LOWER_LETTER, ROMAN_LOWER)):
        pvs = list(rules.getByIndex(lvl))
        for pv in pvs:
            if pv.Name == 'NumberingType': pv.Value = ntype
            elif pv.Name == 'Suffix': pv.Value = '.'
            elif pv.Name == 'Prefix': pv.Value = ''
            elif pv.Name == 'ParentNumbering': pv.Value = 1
            elif pv.Name == 'ListFormat': pv.Value = '%%%d%%.' % (lvl + 1)
        uno.invoke(rules, 'replaceByIndex', (lvl, uno.Any('[]com.sun.star.beans.PropertyValue', tuple(pvs))))
    ml.NumberingRules = rules
    w.para('Standard', ['Bullets:'])
    for text, lvl in (('Fruit', 0), ('Apple', 1), ('Green apple', 2), ('Vegetables', 0)):
        w.para('Standard', [text], numbering='List 1', level=lvl)
    w.para('Standard', ['Numbers:'])
    for text, lvl in (('First', 0), ('Sub a', 1), ('Sub sub i', 2), ('Second', 0)):
        w.para('Standard', [text], numbering='Corpus Multilevel', level=lvl)
    w.para('Standard', ['An interruption.'])
    w.para('Standard', ['Third'], numbering='Corpus Multilevel')
    w.para('Standard', ['A new list:'])
    w.para('Standard', ['Restart one'], numbering='Corpus Multilevel', restart=True)
    w.para('Standard', ['Restart two'], numbering='Corpus Multilevel')
    w.para('Standard', ['End of lists.'])
    w.save('lo%s-lists.docx' % tag)


def tables_doc(o, tag):
    w = Writer(o)
    w.para('Standard', ['Table:'])
    t = w.doc.createInstance('com.sun.star.text.TextTable'); t.initialize(4, 3)
    w.block(t)
    vals = (('Name', 'Qty', 'Note'), ('Wide cell', '', 'Shaded'), ('Tall', '', 'c3'), ('', 'b4', 'c4'))
    for r, row in enumerate(vals):
        for c, v in enumerate(row):
            t.getCellByName('%s%d' % ('ABC'[c], r + 1)).setString(v)
    t.RepeatHeadline = True
    t.HeaderRowCount = 1
    t.getCellByName('C2').BackColor = 0xFFFF00
    inner = w.doc.createInstance('com.sun.star.text.TextTable'); inner.initialize(2, 1)
    cell = t.getCellByName('B3'); cell.setString('')
    cell.insertTextContent(cell.createTextCursor(), inner, False)
    inner.getCellByName('A1').setString('in1'); inner.getCellByName('A2').setString('in2')
    cc = t.createCursorByCellName('A3'); cc.goDown(1, True); cc.mergeRange()
    cc = t.createCursorByCellName('A2'); cc.goRight(1, True); cc.mergeRange()
    w.para('Standard', ['After the table.'])
    w.save('lo%s-tables.docx' % tag)


def media_doc(o, tag, png):
    w = Writer(o)
    w.para('Standard', ['Picture: '])
    g = o.smgr.createInstanceWithContext('com.sun.star.graphic.GraphicProvider', o.ctx).queryGraphic((prop('URL', uno.systemPathToFileUrl(png)),))
    obj = w.doc.createInstance('com.sun.star.text.TextGraphicObject'); obj.Graphic = g; obj.AnchorType = AS_CHARACTER; obj.Size = size(423, 423)
    w.text.insertTextContent(w.cur, obj, False)
    w.para('Standard', ['A link to ', ('the example site', {'HyperLinkURL': 'https://example.com/docs'}), '.'])
    w._break(); w.cur.ParaStyleName = 'Standard'; w.cur.NumberingStyleName = ''
    bm = w.doc.createInstance('com.sun.star.text.Bookmark'); bm.Name = 'target'
    w.text.insertTextContent(w.cur, bm, False)
    w.run('Target paragraph')
    w.para('Standard', ['Jump to ', ('the target', {'HyperLinkURL': '#target'}), '.'])
    w.save('lo%s-media.docx' % tag)


def skipped_doc(o, tag):
    w = Writer(o)
    ps = w.doc.StyleFamilies.getByName('PageStyles').getByName('Standard')
    ps.HeaderIsOn = True; ps.HeaderText.setString('Running header')
    ps.FooterIsOn = True; ps.FooterText.setString('Running footer')
    w.para('Standard', ['Contents:'])
    toc = w.doc.createInstance('com.sun.star.text.ContentIndex'); toc.CreateFromOutline = True
    w.block(toc)
    w.para('Heading 1', ['Chapter one'])
    w.para('Standard', ['Body with a footnote'])
    fn = w.doc.createInstance('com.sun.star.text.Footnote'); w.text.insertTextContent(w.cur, fn, False); fn.setString('The footnote text.')
    w.para('Standard', ['Body with an endnote'])
    en = w.doc.createInstance('com.sun.star.text.Endnote'); w.text.insertTextContent(w.cur, en, False); en.setString('The endnote text.')
    w.para('Standard', ['Anchor for a text box.'])
    fr = w.doc.createInstance('com.sun.star.text.TextFrame'); fr.Size = size(5000, 1000); fr.AnchorType = AT_PARAGRAPH
    w.text.insertTextContent(w.cur, fr, False); fr.getText().setString('Boxed words')
    w.para('Standard', ['Commented words'])
    ann = w.doc.createInstance('com.sun.star.text.textfield.Annotation'); ann.Author = 'Corpus'; ann.Content = 'A comment.'
    w.text.insertTextContent(w.cur, ann, False)
    w.para('Standard', ['Kept deleted words.'])
    c2 = w.text.createTextCursorByRange(w.cur.getEnd())
    c2.goLeft(len('deleted words.'), False)
    w.doc.RecordChanges = True
    w.text.insertString(c2, 'inserted ', False)          # "Kept inserted deleted words."
    c2.goRight(len('deleted '), True); c2.setString('')   # deletes "deleted "
    w.doc.RecordChanges = False
    w.para('Heading 1', ['Chapter two'], page='Landscape')
    w.para('Standard', ['Landscape page.'])
    toc.update()
    w.save('lo%s-skipped.docx' % tag)


def notes_doc(o, tag):
    w = Writer(o)
    fs = w.doc.FootnoteSettings
    fs.NumberingType = 3          # com.sun.star.style.NumberingType.ROMAN_LOWER
    fs.StartAt = 2                # LibreOffice counts StartAt from 0: the first note reads iii
    w.para('Heading 1', ['Notes'])
    for word, text in (('Alpha', 'First note.'), ('Beta', 'Second note.')):
        w.para('Standard', [word])
        fn = w.doc.createInstance('com.sun.star.text.Footnote'); w.text.insertTextContent(w.cur, fn, False); fn.setString(text)
    w.para('Standard', ['Gamma'])
    fn = w.doc.createInstance('com.sun.star.text.Footnote'); fn.setLabel('*')
    w.text.insertTextContent(w.cur, fn, False); fn.setString('Starred note.')
    w.para('Standard', ['Delta'])
    en = w.doc.createInstance('com.sun.star.text.Endnote'); w.text.insertTextContent(w.cur, en, False); en.setString('An endnote.')
    w.save('lo%s-notes.docx' % tag)


def main():
    png = os.path.join(tempfile.gettempdir(), 'gen-docx-corpus-lo.png')
    png16(png)
    with Office() as o:
        v = o.version()
        tag = '.'.join(v.split('.')[:2])
        print('LibreOffice ' + v)
        only = sys.argv[2] if len(sys.argv) > 2 else ''
        for topic, build in (('styles', lambda: styles_doc(o, tag)), ('lists', lambda: lists_doc(o, tag)),
                             ('tables', lambda: tables_doc(o, tag)), ('media', lambda: media_doc(o, tag, png)),
                             ('skipped', lambda: skipped_doc(o, tag)), ('notes', lambda: notes_doc(o, tag))):
            if not only or only == topic:
                build()
    os.remove(png)


main()
