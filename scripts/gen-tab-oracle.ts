// Writes test/fixtures/docx/tab-oracle.docx (v9j3.1). Run by gen-tab-oracle.ps1,
// which then has Word lay it out; not run by npm test.
import { writeFileSync } from 'node:fs';
import { buildTabOracleDocx } from '../test/helpers/build-tab-oracle.js';

writeFileSync(process.argv[2] ?? 'test/fixtures/docx/tab-oracle.docx', buildTabOracleDocx());
