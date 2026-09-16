import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildUaMiscPdf, type UaMiscSpec } from './helpers/build-ua-misc-pdf.js';

/** Rule ids reported for this document at `part`. */
const ids = (spec: UaMiscSpec, part: 1 | 2): string[] =>
  Document.Open(buildUaMiscPdf(spec)).ValidatePdfUa(part).Issues.map((i) => i.rule);

/** A rule must report at part 2 AND be silent at part 1. A single-part
 *  assertion provably cannot tell a rule that correctly went quiet from one
 *  that was never wired up. */
function expectPair(spec: UaMiscSpec, rule: string): void {
  expect(ids(spec, 2), `${rule} at part 2`).toContain(rule);
  expect(ids(spec, 1), `${rule} at part 1`).not.toContain(rule);
}

describe('PDF/UA-2 8.7: optional content', () => {
  it('-1 reports a /Configs entry with no /Name', () => {
    expectPair({ oc: { configs: 1, configName: null } }, 'OcConfigName');
  });

  it('-1 reports an EMPTY /Name', () => {
    expectPair({ oc: { configs: 1, configName: '' } }, 'OcConfigName');
  });

  it('-1 examines /D too, once /Configs exists', () => {
    expectPair({ oc: { configs: 1, configName: 'C', dName: null } }, 'OcConfigName');
  });

  it('-1 is SILENT with no /Configs array, whatever /D says', () => {
    // gContainsConfigs is a document-level variable off /OCProperties. A
    // document carrying only a /D is exempt ENTIRELY -- "including the default"
    // means /D is examined WHEN /Configs is present, not always. A fixture with
    // only a /D measures nothing whatever the code does.
    expect(ids({ oc: { dName: null } }, 2)).not.toContain('OcConfigName');
  });

  it('-1 is silent when every configuration is named', () => {
    expect(ids({ oc: { configs: 1, configName: 'C' } }, 2)).not.toContain('OcConfigName');
  });

  it('-2 reports /AS in a configuration dictionary', () => {
    expectPair({ oc: { configs: 1, configName: 'C', as: true } }, 'OcConfigAs');
  });

  it('-2 reports /AS on a lone /D, being UNGATED unlike -1', () => {
    // The profile test is `AS == null` with no gContainsConfigs guard, so this
    // rule examines a /D even when the document has no /Configs array at all.
    expectPair({ oc: { as: true } }, 'OcConfigAs');
  });

  it('-2 is silent without /AS', () => {
    expect(ids({ oc: { configs: 1, configName: 'C' } }, 2)).not.toContain('OcConfigAs');
  });
});

describe('PDF/UA-2 8.14.1-1: embedded files need a description', () => {
  it('reports an attachment with no /Desc', () => {
    expectPair({ attachment: { desc: null } }, 'EmbeddedFileDesc');
  });

  it('is silent when /Desc is present', () => {
    expect(ids({ attachment: { desc: 'A spreadsheet' } }, 2))
      .not.toContain('EmbeddedFileDesc');
  });

  it('EXEMPTS a filespec that is not in /EmbeddedFiles', () => {
    // The profile's own escape: `presentInEmbeddedFiles == false`. A
    // /FileAttachment annotation's /FS is a file specification and is not in
    // the name tree, so it is not examined -- which is why the walk starts FROM
    // the name tree rather than from every filespec in the file.
    expect(ids({ looseFileSpec: true }, 2)).not.toContain('EmbeddedFileDesc');
  });
});

describe('PDF/UA-2 8.8: intra-document destinations', () => {
  it('-1 reports an outline destination targeting a PAGE', () => {
    expectPair({ outlineDest: true }, 'DestinationNotStructure');
  });

  it('-1 is silent for a document with no destinations at all', () => {
    expect(ids({}, 2)).not.toContain('DestinationNotStructure');
  });

  it('-2 reports a GoTo action with no /SD', () => {
    expectPair({ goTo: {} }, 'GoToNotStructure');
  });

  it('-2 is silent once /SD is present', () => {
    expect(ids({ goTo: { sd: true } }, 2)).not.toContain('GoToNotStructure');
  });

  it('-2 still reports when /D is a structure-destination ARRAY', () => {
    // The asymmetry, and it is the finding: PDDestination treats an array whose
    // first element carries /S as a structure destination, but
    // PDAction.containsStructureDestination falls through to FALSE for a direct
    // array -- only /SD, or a NAMED destination, satisfies an action. A fixture
    // that only toggles /SD present/absent cannot see this at all.
    expectPair({ goTo: { arrayIsStructDest: true } }, 'GoToNotStructure');
  });
});
