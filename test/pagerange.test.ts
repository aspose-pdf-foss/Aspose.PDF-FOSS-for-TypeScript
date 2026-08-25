import { describe, it, expect } from 'vitest';
import { resolvePages } from '../src/pagerange.js';

describe('resolvePages', () => {
  it('defaults to every page', () => {
    expect(resolvePages(undefined, 3)).toEqual([1, 2, 3]);
  });

  it('accepts a number array and normalizes it', () => {
    expect(resolvePages([3, 1], 3)).toEqual([1, 3]);
  });

  it('parses a single page', () => {
    expect(resolvePages('2', 3)).toEqual([2]);
  });

  it('parses an inclusive range', () => {
    expect(resolvePages('1-3', 5)).toEqual([1, 2, 3]);
  });

  it('parses an open-ended range', () => {
    expect(resolvePages('3-', 5)).toEqual([3, 4, 5]);
  });

  it('parses a from-the-start range', () => {
    expect(resolvePages('-3', 5)).toEqual([1, 2, 3]);
  });

  it('parses comma-separated terms', () => {
    expect(resolvePages('1,3-4', 5)).toEqual([1, 3, 4]);
  });

  it('tolerates whitespace', () => {
    expect(resolvePages(' 1 - 2 , 4 ', 5)).toEqual([1, 2, 4]);
  });

  it('normalizes ascending and collapses duplicates', () => {
    expect(resolvePages('3,1-2,1', 5)).toEqual([1, 2, 3]);
  });

  it('throws TypeError on an empty term', () => {
    expect(() => resolvePages('1,,2', 5)).toThrow(TypeError);
  });

  it('throws TypeError on a malformed term', () => {
    expect(() => resolvePages('1-a', 5)).toThrow(TypeError);
  });

  it('throws TypeError on a reversed range', () => {
    expect(() => resolvePages('5-1', 5)).toThrow(TypeError);
  });

  it('throws RangeError past the end', () => {
    expect(() => resolvePages('4-9', 5)).toThrow(RangeError);
  });

  it('throws RangeError on page 0', () => {
    expect(() => resolvePages('0', 5)).toThrow(RangeError);
  });

  it('throws RangeError for an open range starting past the end', () => {
    expect(() => resolvePages('9-', 5)).toThrow(RangeError);
  });

  it('throws RangeError for an array entry out of range', () => {
    expect(() => resolvePages([9], 5)).toThrow(RangeError);
  });

  it('throws TypeError for a non-integer array entry', () => {
    expect(() => resolvePages([1.5], 5)).toThrow(TypeError);
  });
});
