import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildDecryptor } from '../src/crypto.js';
import { InvalidPasswordError } from '../src/errors.js';
import { name, type PdfObject } from '../src/types.js';

const revision3Permissions = {
  printing: true, modifying: false, copying: false, annotating: false,
  fillingForms: false, accessibility: true, assembling: true, highQualityPrinting: false,
};

const cases = [
  {
    file: 'r2-rc4.pdf', user: 'fixture-user', owner: 'fixture-owner',
    permissions: {
      printing: false, modifying: false, copying: false, annotating: true,
      fillingForms: true, accessibility: true, assembling: true, highQualityPrinting: true,
    },
  },
  { file: 'r3-rc4.pdf', user: 'fixture-user', owner: 'fixture-owner', permissions: revision3Permissions },
  {
    file: 'r4-aes128.pdf', user: 'fixture-user-π', owner: 'fixture-owner-🔒',
    permissions: revision3Permissions,
  },
];

describe.each(cases)('qpdf legacy password fixture $file', ({ file, user, owner, permissions }) => {
  const bytes = readFileSync(new URL(`./fixtures/qpdf-legacy-passwords/${file}`, import.meta.url));

  it.each([{ role: 'user', password: user }, { role: 'owner', password: owner }])(
    'opens with the supplied $role password', ({ password }) => {
      const doc = Document.Open(bytes, { password });
      expect(doc.recovery).toBeUndefined();
      expect(doc.GetMetadata().title).toBe('Legacy password fixture');
      expect(doc.Pages[0].GetText()).toContain('Page 1');
      expect(doc.Permissions).toEqual(permissions);
    },
  );

  it('rejects wrong and missing passwords', () => {
    expect(() => Document.Open(bytes, { password: 'incorrect-password' })).toThrow(InvalidPasswordError);
    expect(() => Document.Open(bytes)).toThrow(InvalidPasswordError);
  });

  it('preserves both credentials and permissions after an owner-authenticated save', () => {
    const saved = Document.Open(bytes, { password: owner }).Save();
    expect(() => Document.Open(saved)).toThrow(InvalidPasswordError);
    for (const password of [owner, user]) {
      const doc = Document.Open(saved, { password });
      expect(doc.Pages[0].GetText()).toContain('Page 1');
      expect(doc.Permissions).toEqual(permissions);
    }
  });
});

it('opens V4 AES-128 when the encryption dictionary omits its top-level Length', () => {
  const bytes = readFileSync(new URL('./fixtures/qpdf-legacy-passwords/r4-aes128.pdf', import.meta.url));
  const entry = '/Length 128';
  const offset = bytes.indexOf(entry);
  expect(offset).toBeGreaterThan(-1);
  bytes.fill(0x20, offset, offset + entry.length);

  for (const password of ['fixture-user-π', 'fixture-owner-🔒']) {
    const doc = Document.Open(bytes, { password });
    expect(doc.GetMetadata().title).toBe('Legacy password fixture');
    expect(doc.Pages[0].GetText()).toContain('Page 1');
    expect(doc.Permissions).toEqual(revision3Permissions);
  }
});

// Independently calculated Algorithm 3 and qpdf-style vectors for the same
// 64-bit R3 credentials. The two derivations differ only below 128 bits.
it.each([
  ['full digest', 'e326c78dd2b9e066afb74f208a618b1d63bd0ed3b15cdd4dad44f75c9eca5030',
    '5cd84f237b6ad2997ba33023901d5b9900000000000000000000000000000000', 'b5358edeb2bfa0dd'],
  ['truncated digest', '08c1d729f83d4f8a9170ffad33cb61bd5957a3ead2ca8589396fe00c93430f4c',
    '9b80b1a97dcc45302f927f8ebadc57ed00000000000000000000000000000000', '6d09fab88df78bd5'],
])('authenticates a 64-bit R3 owner password with the %s', (_variant, owner, user, fileKey) => {
  const dict = new Map<string, PdfObject>([
    ['Filter', name('Standard')], ['V', 2], ['R', 3], ['Length', 64], ['P', -2364],
    ['O', { kind: 'string', bytes: Buffer.from(owner, 'hex') }],
    ['U', { kind: 'string', bytes: Buffer.from(user, 'hex') }],
  ]);
  const id = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const open = (password: string) => buildDecryptor(dict, id, password, (value) => value ?? null);
  for (const password of ['fixture-user', 'fixture-owner']) {
    const result = open(password);
    expect(result?.keys.fileKey).toEqual(Uint8Array.from(Buffer.from(fileKey, 'hex')));
  }
  expect(() => open('incorrect-password')).toThrow(InvalidPasswordError);
});
