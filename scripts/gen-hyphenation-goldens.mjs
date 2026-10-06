// scripts/gen-hyphenation-goldens.mjs — goldens from hyphen@1.14.1, an
// independent Liang implementation (npm, MIT). NOT a dependency: fetched with
// `npm pack` into a temp dir. Not run by `npm test`.
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'hyphen-'));
execSync('npm pack hyphen@1.14.1 --silent', { cwd: dir });
execSync('tar xzf hyphen-1.14.1.tgz', { cwd: dir });
const require = createRequire(join(dir, 'package', 'x.js'));
const createHyphenator = require('./hyphen.js');

const FILES = { 'en-US': 'en-us', 'en-GB': 'en-gb', de: 'de-1996', fr: 'fr', es: 'es', it: 'it', nl: 'nl', pt: 'pt', pl: 'pl' };
// Long words, so each has several points. The list is not an authority — the
// oracle decides the expected hyphenation.
const WORDS = {
  'en-US': ['hyphenation', 'beautiful', 'certain', 'algorithm', 'documentation', 'information', 'representation', 'possibility', 'communication', 'international', 'mathematics', 'environment', 'responsibility', 'understanding', 'development', 'organization', 'everything', 'performance', 'independent', 'relationship'],
  'en-GB': ['hyphenation', 'beautiful', 'colour', 'organisation', 'programme', 'favourite', 'centimetre', 'behaviour', 'neighbourhood', 'recognise', 'catalogue', 'labourer', 'documentation', 'responsibility', 'international'],
  de: ['gewisser', 'König', 'hatte', 'wunderschönen', 'Garten', 'Silbentrennung', 'Donaudampfschifffahrt', 'Rechtsschutzversicherung', 'Bundesverfassungsgericht', 'Zusammenarbeit', 'Verantwortung', 'Entwicklung', 'Wissenschaft', 'Gesellschaft', 'Unabhängigkeit'],
  fr: ['hyphénation', 'développement', 'gouvernement', 'international', 'responsabilité', 'compréhension', 'extraordinaire', 'indépendance', 'communication', 'mathématiques', 'environnement', 'connaissance', 'représentation', 'possibilité', 'organisation', 'l’organisation', "l'organisation", 'd’indépendance'],
  es: ['separación', 'desarrollo', 'gobierno', 'internacional', 'responsabilidad', 'comprensión', 'extraordinario', 'independencia', 'comunicación', 'matemáticas', 'conocimiento', 'representación', 'posibilidad', 'organización', 'universidad'],
  it: ['sillabazione', 'sviluppo', 'governo', 'internazionale', 'responsabilità', 'comprensione', 'straordinario', 'indipendenza', 'comunicazione', 'matematica', 'conoscenza', 'rappresentazione', 'possibilità', 'organizzazione', 'università', "dell'organizzazione", 'l’università'],
  nl: ['woordafbreking', 'ontwikkeling', 'regering', 'internationaal', 'verantwoordelijkheid', 'begrijpen', 'buitengewoon', 'onafhankelijkheid', 'communicatie', 'wiskunde', 'kennis', 'vertegenwoordiging', 'mogelijkheid', 'organisatie', 'universiteit'],
  pt: ['hifenização', 'desenvolvimento', 'governo', 'internacional', 'responsabilidade', 'compreensão', 'extraordinário', 'independência', 'comunicação', 'matemática', 'conhecimento', 'representação', 'possibilidade', 'organização', 'universidade'],
  pl: ['przenoszenie', 'rozwój', 'rząd', 'międzynarodowy', 'odpowiedzialność', 'zrozumienie', 'nadzwyczajny', 'niepodległość', 'komunikacja', 'matematyka', 'wiedza', 'przedstawienie', 'możliwość', 'organizacja', 'uniwersytet'],
};

const out = {};
for (const [tag, file] of Object.entries(FILES)) {
  const h = createHyphenator(require(`./patterns/${file}.js`), { hyphenChar: '-', minWordLength: 1 });
  out[tag] = Object.fromEntries(WORDS[tag].map((w) => [w, h(w)]));
}
writeFileSync('test/fixtures/hyphenation/goldens.json', JSON.stringify(out, null, 2) + '\n');
console.log('wrote goldens for', Object.keys(out).join(', '));
