import type { Document } from './document.js';
import type { ConvertAction } from './conversion.js';
import type { ValidationIssue } from './validation.js';
import { decodePdfByteString, decodePdfText, encodePdfByteString, encodePdfText } from './metadata.js';
import { pdfDateToIso } from './pdfdate.js';
import { isArray, isDict, isName, isRef, isStream, isString, name,
  type PdfDict, type PdfObject, type PdfRef, type PdfStream } from './types.js';

type Container = PdfDict | PdfObject[];

/** Walk live containers only. Ignoring the catalog /AF edge answers whether a
 *  removed name-tree value still has another owner. Never decode stream data. */
export function* reachableContainers(doc: Document, skipCatalogAF = false): Generator<Container> {
  const catalog = doc.catalog();
  const seen = new Set<Container>([catalog]);
  const pending: Container[] = [catalog];
  while (pending.length) {
    const parent = pending.pop()!;
    yield parent;
    for (const [key, raw] of parent.entries()) {
      if (skipCatalogAF && parent === catalog && key === 'AF') continue;
      const value = doc.resolve(raw);
      const child = isStream(value) ? value.dict : value;
      if ((!isDict(child) && !isArray(child)) || seen.has(child)) continue;
      seen.add(child);
      pending.push(child);
    }
  }
}

interface FileSpec {
  ref?: PdfRef;
  directUses: ((ref: PdfRef) => void)[];
}

const fileKeys = ['F', 'UF', 'DOS', 'Mac', 'Unix'];

function hasEmbeddedStream(doc: Document, fs: PdfDict): boolean {
  const ef = doc.resolve(fs.get('EF'));
  if (!isDict(ef)) return false;
  return fileKeys.some(key => isStream(doc.resolve(ef.get(key))));
}

/** Gather incoming edges before changing any. A direct filespec must become
 *  one indirect object at every original location as well as in /AF. */
function inventory(doc: Document) {
  const files = new Map<PdfDict, FileSpec>();
  const associated = new Set<PdfObject>();
  const streams = new Map<PdfStream, PdfRef | undefined>();
  for (const parent of reachableContainers(doc)) {
    if (isDict(parent)) {
      const af = doc.resolve(parent.get('AF'));
      if (isArray(af)) for (const entry of af) associated.add(doc.resolve(entry));
    }
    for (const [key, raw] of parent.entries()) {
      const fs = doc.resolve(raw);
      if (!isDict(fs) || !fs.has('EF')) continue;
      const type = doc.resolve(fs.get('Type'));
      // /Type is optional. For an untyped dictionary require an embedded
      // stream in a file slot, since resource names can also be named EF.
      if (type === null && !hasEmbeddedStream(doc, fs)) continue;
      if (type !== null && (!isName(type) || type.name !== 'Filespec')) continue;
      let file = files.get(fs);
      if (!file) {
        file = { directUses: [] };
        files.set(fs, file);
        const ef = doc.resolve(fs.get('EF'));
        if (isDict(ef)) for (const fileKey of fileKeys) {
          const v = ef.get(fileKey);
          const stream = doc.resolve(v);
          if (isStream(stream)) streams.set(stream, isRef(v) ? v : undefined);
        }
      }
      if (isRef(raw)) file.ref = raw;
      else if (isDict(parent) && typeof key === 'string') file.directUses.push(ref => parent.set(key, ref));
      else if (isArray(parent) && typeof key === 'number') file.directUses.push(ref => { parent[key] = ref; });
    }
  }
  return { files, associated, streams };
}

export function validateAssociatedFiles(doc: Document): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const report = (message: string, object?: PdfRef) => {
    issues.push({ rule: 'EmbeddedFileSpec', severity: 'error', clause: 'ISO 19005-3 §6.8 and Annex E', object, message });
  };
  const { files, associated, streams } = inventory(doc);
  const catalog = doc.catalog();
  if (catalog.has('AF') && !isArray(doc.resolve(catalog.get('AF')))) report('Catalog /AF must be an array.');
  for (const [fs, file] of files) {
    if (!associated.has(fs)) report('Embedded file specification lacks an /AF association.', file.ref);
    if (file.directUses.length) report('Embedded file specification must be indirect.', file.ref);
    const relation = doc.resolve(fs.get('AFRelationship'));
    if (!isName(relation) || !relation.name) report('Missing or malformed /AFRelationship name.', file.ref);
    for (const key of ['F', 'UF']) {
      if (!isString(doc.resolve(fs.get(key)))) report(`Missing or malformed /${key} filename.`, file.ref);
    }
    if (!hasEmbeddedStream(doc, fs))
      report('Embedded file /EF does not reference a stream.', file.ref);
  }
  for (const [stream, ref] of streams) {
    const mime = doc.resolve(stream.dict.get('Subtype'));
    // Match the vendored veraPDF PDF/A-3B profile, clause 6.8 test 1.
    if (!isName(mime) || !/^[-\w+.]+\/[-\w+.]+$/.test(mime.name))
      report('Missing or malformed embedded file MIME /Subtype.', ref);
    if (!stream.dict.has('Params')) continue;
    const params = doc.resolve(stream.dict.get('Params'));
    if (!isDict(params)) { report('Embedded file /Params must be a dictionary.', ref); continue; }
    for (const key of ['ModDate', 'CreationDate']) {
      if (key === 'CreationDate' && !params.has(key)) continue;
      const date = doc.resolve(params.get(key));
      if (!isString(date) || pdfDateToIso(decodePdfByteString(date.bytes)) === undefined)
        report(`Missing or malformed embedded file /${key}.`, ref);
    }
  }
  return issues;
}

/** Reuse the filespec reference shared by the source's annotations and name trees,
 *  promoting direct uses of this specification when necessary. */
export function registerFilespec(doc: Document, fs: PdfDict): PdfRef {
  const file = inventory(doc).files.get(fs);
  const ref = file?.ref ?? doc.allocObject(fs);
  for (const replace of file?.directUses ?? []) replace(ref);
  return ref;
}

export function repairAssociatedFiles(doc: Document): ConvertAction[] {
  const { files, associated, streams } = inventory(doc);
  const actions: ConvertAction[] = [];
  const record = (action: string, object?: PdfRef) => actions.push({ rule: 'EmbeddedFileSpec', action, object });
  const catalog = doc.catalog();
  let af = doc.resolve(catalog.get('AF'));
  for (const [fs, file] of files) {
    const ref = file.ref ?? doc.allocObject(fs);
    if (file.directUses.length) {
      for (const replace of file.directUses) replace(ref);
      record('Made the embedded file specification indirect at its original location.', ref);
    }
    if (!associated.has(fs)) {
      if (!catalog.has('AF')) { af = []; catalog.set('AF', af); }
      if (isArray(af)) {
        af.push(ref);
        record('Associated the embedded file with the catalog.', ref);
      }
    }
    if (!fs.has('AFRelationship')) {
      fs.set('AFRelationship', name('Unspecified'));
      record('Set the missing /AFRelationship to /Unspecified.', ref);
    }
    const f = doc.resolve(fs.get('F')), uf = doc.resolve(fs.get('UF'));
    if (!fs.has('UF') && isString(f)) {
      fs.set('UF', { kind: 'string', bytes: encodePdfText(decodePdfByteString(f.bytes)) });
      record('Derived the missing /UF from /F.', ref);
    }
    if (!fs.has('F') && isString(uf)) {
      fs.set('F', { kind: 'string', bytes: encodePdfByteString(decodePdfText(uf.bytes)) });
      record('Derived the missing /F from /UF.', ref);
    }
  }
  for (const [stream, ref] of streams) {
    if (stream.dict.has('Subtype')) continue;
    stream.dict.set('Subtype', name('application/octet-stream'));
    record('Set the missing embedded file MIME type to application/octet-stream.', ref);
  }
  if (isArray(af)) {
    const seen = new Set<PdfDict>();
    let kept = 0;
    for (const entry of af) {
      const fs = doc.resolve(entry);
      if (isDict(fs) && files.has(fs)) {
        if (seen.has(fs)) { record('Removed a duplicate catalog /AF entry.', isRef(entry) ? entry : undefined); continue; }
        seen.add(fs);
      }
      af[kept++] = entry;
    }
    af.length = kept;
  }
  return actions;
}
