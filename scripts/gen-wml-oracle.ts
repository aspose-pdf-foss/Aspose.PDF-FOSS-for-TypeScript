// Writes test/fixtures/docx/wml-oracle.docx (m2fp.3). Run by gen-wml-oracle.ps1,
// which then has Word read it; not run by npm test.
import { writeFileSync } from 'node:fs';
import { buildWmlOracleDocx } from '../test/helpers/build-wml-oracle.js';

writeFileSync(process.argv[2] ?? 'test/fixtures/docx/wml-oracle.docx', buildWmlOracleDocx());
