import { describe, it, expect } from 'vitest';
import { filterDisallowedHtml } from '../src/mdgfm.js';

describe('filterDisallowedHtml', () => {
  it('escapes the leading < of a disallowed tag', () => {
    expect(filterDisallowedHtml('<strong> <title> <style> <em>')).toBe('<strong> &lt;title> &lt;style> <em>');
  });

  it('is case insensitive', () => {
    expect(filterDisallowedHtml('<XMP> and <xmp>')).toBe('&lt;XMP> and &lt;xmp>');
  });

  it('escapes closing tags too', () => {
    expect(filterDisallowedHtml('</script>')).toBe('&lt;/script>');
  });

  it('leaves a longer name that merely starts the same alone', () => {
    expect(filterDisallowedHtml('<styled> <titles>')).toBe('<styled> <titles>');
  });

  it('leaves every other tag untouched', () => {
    expect(filterDisallowedHtml('<div class="x"> <br/>')).toBe('<div class="x"> <br/>');
  });
});
