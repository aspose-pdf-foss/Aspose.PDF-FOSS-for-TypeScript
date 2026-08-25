import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { InvalidPasswordError } from '../src/errors.js';
import {
  corruptStartxref, destroyTrailer, corruptObjectBody, appendCatalog,
} from './helpers/damage-pdf.js';

describe('object-stream expansion on the recovery path', () => {
  it('reaches a catalog that lives inside an /ObjStm', () => {
    // /Root, /Pages and the page dict are all inside an /ObjStm, which carries
    // no `N G obj` header of its own. Without expansion the merged entry map
    // has only the container, and /Root resolves to null.
    const compressed = Document.Open(buildBlankPage()).Save({ compressed: true });
    const doc = Document.Open(corruptStartxref(compressed));

    expect(doc.Pages.length).toBe(1);
    expect(doc.recovery?.reason).toBe('startxref-unreadable');
  });

  it('still opens a healthy compressed file without sweeping', () => {
    const compressed = Document.Open(buildBlankPage()).Save({ compressed: true });
    expect(Document.Open(compressed).recovery).toBeUndefined();
  });
});

describe('trailer synthesis', () => {
  it('opens a file whose trailer keyword is destroyed', () => {
    const good = buildClassicPdf(2, { info: { Title: 'Original', Producer: 'Builder' } });
    const doc = Document.Open(destroyTrailer(good));

    expect(doc.Pages.length).toBe(2);
    expect(doc.Pages[0].GetText()).toBe(Document.Open(good).Pages[0].GetText());
    expect(doc.GetMetadata().title).toBe('Original');
    expect(doc.GetMetadata().producer).toBe('Builder');
  });

  it('reports which objects it chose', () => {
    const good = buildClassicPdf(1, { info: { Title: 'Original' } });
    const doc = Document.Open(destroyTrailer(good));

    expect(doc.recovery!.trailer).toEqual({
      root: 1, rootCandidates: [1], info: 5, infoSource: 'info-dict',
    });
  });

  it('throws with a distinct message when no catalog survives', () => {
    // Object 1 is the catalog; corrupting its body in place means it never
    // parses, so there is no /Type /Catalog anywhere to synthesize around.
    // destroyTrailer, not corruptStartxref: the latter leaves the trailer dict
    // readable, so recoverTrailer succeeds and synthesis is never reached.
    const pdf = destroyTrailer(corruptObjectBody(buildClassicPdf(2), 1));
    expect(() => Document.Open(pdf)).toThrow(/no \/Type \/Catalog object found/);
  });

  it('prefers a surviving trailer over synthesis', () => {
    // The trailer keyword is intact here, so recoverTrailer wins and nothing is
    // synthesized. Red if synthesis is ever tried first.
    const doc = Document.Open(corruptStartxref(buildClassicPdf(2)));
    expect(doc.recovery).toBeDefined();
    expect(doc.recovery!.trailer).toBeUndefined();
  });
});

describe('several catalog candidates', () => {
  it('takes the latest one when both are walkable', () => {
    // Object 2 is the page tree in buildClassicPdf, so catalog 99 is walkable
    // and sits at a higher offset than catalog 1.
    const pdf = destroyTrailer(appendCatalog(buildClassicPdf(2), 99, 2));
    const doc = Document.Open(pdf);

    expect(doc.recovery!.trailer!.root).toBe(99);
    expect(doc.recovery!.trailer!.rootCandidates).toEqual([1, 99]);
    expect(doc.Pages.length).toBe(2);
  });

  it('takes the earlier walkable one when the latest points nowhere', () => {
    // Object 77 does not exist, so catalog 99 has no page tree. The
    // tail-truncation case: the newest catalog is the broken one.
    const pdf = destroyTrailer(appendCatalog(buildClassicPdf(2), 99, 77));
    const doc = Document.Open(pdf);

    expect(doc.recovery!.trailer!.root).toBe(1);
    expect(doc.recovery!.trailer!.rootCandidates).toEqual([1, 99]);
    expect(doc.Pages.length).toBe(2);
  });
});

describe('/Info against a real outline', () => {
  it('does not mistake an outline item for /Info', () => {
    // An outline item carries /Title and no /Type, so a key-set test alone
    // matches it. It is reachable from /Root, which is what rules it out.
    const src = Document.Open(buildClassicPdf(1, { info: { Title: 'The Document' } }));
    src.SetOutlines([{ Title: 'Chapter One' }, { Title: 'Chapter Two' }]);
    const doc = Document.Open(destroyTrailer(src.Save()));

    expect(doc.GetMetadata().title).toBe('The Document');
    expect(doc.recovery!.trailer!.infoSource).toBe('info-dict');
  });
});

describe('/Info recovered from XMP', () => {
  it('falls back to the /Root /Metadata packet when no /Info dict survives', () => {
    const src = Document.Open(buildClassicPdf(1));
    src.SetXmp({ title: 'From XMP', producer: 'XMP Producer' });
    // SetXmp mirrors into /Info; unlink it so only the XMP packet carries the
    // metadata. Save()'s mark-sweep then drops the orphaned dict.
    src.trailer.delete('Info');
    const pdf = src.Save();

    const doc = Document.Open(destroyTrailer(pdf));
    expect(doc.recovery!.trailer!.infoSource).toBe('xmp');
    expect(doc.GetMetadata().title).toBe('From XMP');
    expect(doc.GetMetadata().producer).toBe('XMP Producer');
  });

  it('leaves /Info absent when there is neither a dict nor XMP', () => {
    const doc = Document.Open(destroyTrailer(buildClassicPdf(1)));
    expect(doc.recovery!.trailer!.info).toBeUndefined();
    expect(doc.recovery!.trailer!.infoSource).toBeUndefined();
    expect(doc.GetMetadata().title).toBeUndefined();
  });
});

describe('encrypted documents with no trailer', () => {
  it('recovers an AES-256 document — R6 derives its key without /ID', () => {
    const good = buildClassicPdf(1);
    const enc = Document.Open(good)
      .Save({ encrypt: { algorithm: 'aes256', userPassword: 'pw' } });
    const doc = Document.Open(destroyTrailer(enc), { password: 'pw' });

    expect(doc.Pages.length).toBe(1);
    expect(doc.recovery!.trailer!.root).toBeGreaterThan(0);
    // The page tree walks even with no decryptor at all — only strings and
    // streams are encrypted — so assert on decrypted *content*, or this passes
    // whether or not /Encrypt was ever recovered.
    expect(doc.Pages[0].GetText()).toBe(Document.Open(good).Pages[0].GetText());
  });

  it('refuses AES-128, naming /ID rather than reporting a wrong password', () => {
    const enc = Document.Open(buildClassicPdf(1))
      .Save({ encrypt: { algorithm: 'aes128', userPassword: 'pw' } });

    // The regression this message exists to prevent: fileKeyR234 hashes id0, so
    // an empty one fails /U validation and InvalidPasswordError is thrown for a
    // correct password, sending the caller hunting in the wrong place.
    expect(() => Document.Open(destroyTrailer(enc), { password: 'pw' }))
      .toThrow(/\/ID was lost with the trailer/);
    expect(() => Document.Open(destroyTrailer(enc), { password: 'pw' }))
      .not.toThrow(InvalidPasswordError);
  });

  it('refuses RC4 the same way', () => {
    const enc = Document.Open(buildClassicPdf(1))
      .Save({ encrypt: { algorithm: 'rc4', userPassword: 'pw' } });
    expect(() => Document.Open(destroyTrailer(enc), { password: 'pw' }))
      .toThrow(/\/ID was lost with the trailer/);
  });
});

describe('the error ladder', () => {
  it('says nothing was found, not that no catalog was found', () => {
    // Three distinct messages: nothing in the file, objects but no catalog,
    // catalog found. Collapsing the first two tells a caller with a truncated
    // download the same thing as a caller with a shredded catalog.
    expect(() => Document.Open(new Uint8Array([0x25, 0x50, 0x44, 0x46])))
      .toThrow(/no indirect objects found/);
  });
});
