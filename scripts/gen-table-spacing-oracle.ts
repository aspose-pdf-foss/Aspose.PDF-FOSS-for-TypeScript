// Writes test/fixtures/docx/table-spacing-oracle.docx (m2fp.10). Run by
// gen-table-spacing-oracle.ps1, which then has Word lay it out; not run by npm test.
import { writeFileSync } from 'node:fs';
import { buildTableSpacingOracleDocx } from '../test/helpers/build-table-spacing-oracle.js';

writeFileSync(process.argv[2] ?? 'test/fixtures/docx/table-spacing-oracle.docx', buildTableSpacingOracleDocx());
