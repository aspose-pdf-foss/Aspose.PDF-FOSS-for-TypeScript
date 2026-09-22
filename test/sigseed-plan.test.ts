import { describe, it, expect } from 'vitest';
import { planSeedValue, type SeedValue, type SeedRequest } from '../src/sigseed.js';
import { SeedValueError } from '../src/errors.js';

const approve: SeedRequest = { certify: false, hasTimestamp: false };
const certify: SeedRequest = { certify: true, hasTimestamp: false };

/** The entry a refusal names, or undefined when the plan is accepted. */
function refusal(sv: SeedValue, req: SeedRequest): string | undefined {
  try { planSeedValue(sv, req); return undefined; } catch (e) {
    if (e instanceof SeedValueError) return e.entry;
    throw e;
  }
}

describe('planSeedValue — nothing binds, nothing refuses (puep.3)', () => {
  it('an empty seed value plans nothing', () => {
    expect(planSeedValue({}, approve)).toEqual({});
  });

  it('advisory entries never refuse', () => {
    const sv: SeedValue = {
      filter: 'Other.Handler', v: 9, reasons: ['a'], appearanceFilter: 'x',
      addRevInfo: true, lockDocument: 'true', digestMethod: ['SHA1'], subFilter: ['x.y'],
    };
    expect(refusal(sv, { ...approve, reason: 'unlisted', digest: 'sha256', subFilter: 'CMS' })).toBeUndefined();
  });
});

describe('planSeedValue — defaults FOLLOWED from the seed value (puep.3)', () => {
  it('takes the first SUPPORTED digest when the signer states none', () => {
    expect(planSeedValue({ digestMethod: ['SHA1', 'SHA384', 'SHA256'] }, approve).digest).toBe('sha384');
  });

  it('keeps the signer\'s stated digest over an advisory list', () => {
    // A plan sets only what the seed value DECIDED; a stated digest stays the signer's.
    expect(planSeedValue({ digestMethod: ['SHA384'] }, { ...approve, digest: 'sha256' }).digest).toBeUndefined();
  });

  it('takes the first SUPPORTED subfilter when the caller states none', () => {
    expect(planSeedValue({ subFilter: ['x.unknown', 'ETSI.CAdES.detached', 'adbe.pkcs7.detached'] }, approve).subFilter)
      .toBe('PAdES');
    expect(planSeedValue({ subFilter: ['adbe.pkcs7.detached'] }, approve).subFilter).toBe('CMS');
  });

  it('plans no timestamp URL for an ADVISORY timestamp', () => {
    expect(planSeedValue({ timestamp: { url: 'https://t', required: false } }, approve).timestampUrl).toBeUndefined();
  });

  it('plans the /SV URL for a REQUIRED timestamp when the caller supplied none', () => {
    expect(planSeedValue({ timestamp: { url: 'https://t', required: true } }, approve).timestampUrl).toBe('https://t');
  });

  it('prefers the caller\'s own TSA over a required /SV URL', () => {
    expect(planSeedValue({ timestamp: { url: 'https://t', required: true } }, { ...approve, hasTimestamp: true })
      .timestampUrl).toBeUndefined();
  });
});

describe('planSeedValue — required entries (puep.3)', () => {
  it('filter: only Adobe.PPKLite is honoured', () => {
    expect(refusal({ filter: 'Adobe.PPKLite', required: ['filter'] }, approve)).toBeUndefined();
    expect(refusal({ filter: 'Entrust.PPKEF', required: ['filter'] }, approve)).toBe('filter');
  });

  it('subFilter: the stated one must be the first supported entry', () => {
    const sv: SeedValue = { subFilter: ['ETSI.CAdES.detached', 'adbe.pkcs7.detached'], required: ['subFilter'] };
    expect(refusal(sv, { ...approve, subFilter: 'PAdES' })).toBeUndefined();
    expect(refusal(sv, { ...approve, subFilter: 'CMS' })).toBe('subFilter');
    expect(refusal({ subFilter: ['x.y'], required: ['subFilter'] }, approve)).toBe('subFilter');
  });

  it('digestMethod: a stated digest outside the list is refused', () => {
    const sv: SeedValue = { digestMethod: ['SHA384'], required: ['digestMethod'] };
    expect(refusal(sv, { ...approve, digest: 'sha256' })).toBe('digestMethod');
    expect(refusal(sv, { ...approve, digest: 'sha384' })).toBeUndefined();
    expect(planSeedValue(sv, approve).digest).toBe('sha384');
  });

  it('digestMethod: SHA-1 is refused, never substituted', () => {
    expect(refusal({ digestMethod: ['SHA1'], required: ['digestMethod'] }, approve)).toBe('digestMethod');
    expect(refusal({ digestMethod: ['SHA1', 'RIPEMD160'], required: ['digestMethod'] }, approve)).toBe('digestMethod');
  });

  it('v: up to 3 (PDF 2.0) is honoured, beyond it refused', () => {
    expect(refusal({ v: 3, required: ['v'] }, approve)).toBeUndefined();
    expect(refusal({ v: 4, required: ['v'] }, approve)).toBe('v');
  });

  it('reasons: the given reason must be listed, and one must be given', () => {
    const sv: SeedValue = { reasons: ['Approved', 'Reviewed'], required: ['reasons'] };
    expect(refusal(sv, { ...approve, reason: 'Approved' })).toBeUndefined();
    expect(refusal(sv, { ...approve, reason: 'Because' })).toBe('reasons');
    expect(refusal(sv, approve)).toBe('reasons');
  });

  it('reasons: [] and [\'.\'] forbid giving a reason at all', () => {
    for (const reasons of [[], ['.']]) {
      const sv: SeedValue = { reasons, required: ['reasons'] };
      expect(refusal(sv, approve)).toBeUndefined();
      expect(refusal(sv, { ...approve, reason: 'x' })).toBe('reasons');
    }
  });

  it('reasons: a required entry with NO list (a foreign file) forbids a reason', () => {
    expect(refusal({ required: ['reasons'] }, { ...approve, reason: 'x' })).toBe('reasons');
  });

  it('legalAttestation: required is vacuously met, since none is supplied', () => {
    expect(refusal({ legalAttestation: ['a'], required: ['legalAttestation'] }, approve)).toBeUndefined();
  });

  it('appearanceFilter: a required named appearance is refused', () => {
    expect(refusal({ appearanceFilter: 'Stamp', required: ['appearanceFilter'] }, approve)).toBe('appearanceFilter');
  });

  it('addRevInfo: required true is refused, required false honoured', () => {
    expect(refusal({ addRevInfo: true, required: ['addRevInfo'] }, approve)).toBe('addRevInfo');
    expect(refusal({ addRevInfo: false, required: ['addRevInfo'] }, approve)).toBeUndefined();
  });

  it('timestamp: a required one with a non-http URL and no TSA is refused', () => {
    expect(refusal({ timestamp: { url: 'file:///etc/passwd', required: true } }, approve)).toBe('timestamp');
    expect(refusal({ timestamp: { url: 'ldap://x', required: true } }, approve)).toBe('timestamp');
    expect(refusal({ timestamp: { url: 'http://tsa.local/x', required: true } }, approve)).toBeUndefined();
  });
});

describe('planSeedValue — /MDP always binds (puep.3)', () => {
  it('refuses Sign on a certification field and Certify on an approval field', () => {
    expect(refusal({ mdp: 'form-fill' }, approve)).toBe('mdp');
    expect(refusal({ mdp: 'approval' }, certify)).toBe('mdp');
    expect(refusal({ mdp: 'approval' }, approve)).toBeUndefined();
  });

  it('gives Certify the field\'s level when the caller states none', () => {
    expect(planSeedValue({ mdp: 'form-fill-and-annotate' }, certify).permissions).toBe('form-fill-and-annotate');
  });

  it('refuses a Certify level that conflicts with the field\'s', () => {
    expect(refusal({ mdp: 'form-fill' }, { ...certify, permissions: 'no-changes' })).toBe('mdp');
    expect(refusal({ mdp: 'form-fill' }, { ...certify, permissions: 'form-fill' })).toBeUndefined();
  });
});

describe('planSeedValue — /LockDocument (puep.3)', () => {
  it('Certify: required true forces no-changes, and refuses another level', () => {
    const sv: SeedValue = { lockDocument: 'true', required: ['lockDocument'] };
    expect(planSeedValue(sv, certify).permissions).toBe('no-changes');
    expect(refusal(sv, { ...certify, permissions: 'form-fill' })).toBe('lockDocument');
  });

  it('Certify: required false forbids no-changes, and defaults to form-fill', () => {
    const sv: SeedValue = { lockDocument: 'false', required: ['lockDocument'] };
    expect(planSeedValue(sv, certify).permissions).toBe('form-fill');
    expect(refusal(sv, { ...certify, permissions: 'no-changes' })).toBe('lockDocument');
  });

  it('Certify: an ADVISORY lock only recommends the unstated level', () => {
    expect(planSeedValue({ lockDocument: 'false' }, certify).permissions).toBe('form-fill');
    expect(planSeedValue({ lockDocument: 'false' }, { ...certify, permissions: 'no-changes' }).permissions)
      .toBeUndefined();
  });

  it('Certify: a required lock that contradicts /MDP is refused', () => {
    expect(refusal({ mdp: 'form-fill', lockDocument: 'true', required: ['lockDocument'] }, certify))
      .toBe('lockDocument');
  });

  // puep.7 REVERSED puep.3's refusal: an approval signature locks through the
  // field's /Lock /P, so a required lock is now honoured.
  it('Sign: a required lock plans a no-changes /Lock /P', () => {
    expect(planSeedValue({ lockDocument: 'true', required: ['lockDocument'] }, approve).lockPermissions)
      .toBe('no-changes');
    expect(planSeedValue({ lockDocument: 'false', required: ['lockDocument'] }, approve).lockPermissions)
      .toBeUndefined();
    expect(planSeedValue({ lockDocument: 'auto', required: ['lockDocument'] }, approve).lockPermissions)
      .toBeUndefined();
  });

  it('Sign: an ADVISORY lock imposes nothing', () => {
    expect(planSeedValue({ lockDocument: 'true' }, approve).lockPermissions).toBeUndefined();
  });

  it('Sign: a field already at no-changes needs nothing written', () => {
    expect(planSeedValue({ lockDocument: 'true', required: ['lockDocument'] },
      { ...approve, lockPermissions: 'no-changes' }).lockPermissions).toBeUndefined();
  });

  it('a field whose /Lock /P contradicts a REQUIRED lock is refused, for Sign and Certify', () => {
    const lockTrue: SeedValue = { lockDocument: 'true', required: ['lockDocument'] };
    const lockFalse: SeedValue = { lockDocument: 'false', required: ['lockDocument'] };
    expect(refusal(lockTrue, { ...approve, lockPermissions: 'form-fill' })).toBe('lockDocument');
    expect(refusal(lockFalse, { ...approve, lockPermissions: 'no-changes' })).toBe('lockDocument');
    expect(refusal(lockTrue, { ...certify, lockPermissions: 'form-fill' })).toBe('lockDocument');
    expect(refusal(lockFalse, { ...approve, lockPermissions: 'form-fill' })).toBeUndefined();
  });
});
