// Writes test/fixtures/docx/spacing-oracle.docx (m2fp.5). Run by gen-spacing-oracle.ps1,
// which then has Word lay it out; not run by npm test.
import { writeFileSync } from 'node:fs';
import { buildSpacingOracleDocx } from '../test/helpers/build-spacing-oracle.js';

writeFileSync(process.argv[2] ?? 'test/fixtures/docx/spacing-oracle.docx', buildSpacingOracleDocx());
