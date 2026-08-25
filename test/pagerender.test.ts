import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { interpret, baseMatrix, RenderSink, Path, Matrix, StrokeStyle, TextRunInfo } from '../src/pagerender.js';
import { buildSvgPdf, VECTOR_CONTENT, HELV_RESOURCES, TEXT_CONTENT } from './helpers/build-svg-fixtures.js';

/** A sink that records which primitives the interpreter emits. */
class RecordingSink implements RenderSink {
  fills = 0; strokes = 0; clips = 0; glyphRuns: string[] = []; saves = 0; restores = 0;
  save() { this.saves++; }
  restore() { this.restores++; }
  addClip(_p: Path, _m: Matrix, _e: boolean) { this.clips++; }
  clipToStroke() { this.clips++; }
  clipToGlyphs() { this.clips++; return true; }
  fill() { this.fills++; }
  stroke() { this.strokes++; }
  image() {}
  glyphRun(info: TextRunInfo) { this.glyphRuns.push(info.decoded.text); }
  shading() {}
  setAlpha() {}
  setBlend() {}
  beginOffscreen() {}
  endOffscreen() {}
  beginKnockoutElement() {}
  endKnockoutElement() {}
  clearSoftMask() {}
}

describe('pagerender.interpret drives a RenderSink', () => {
  it('emits fill and stroke for a vector page', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: VECTOR_CONTENT }));
    const page = doc.Pages[0];
    const { matrix } = baseMatrix(page, 'crop');
    const sink = new RecordingSink();
    interpret(doc, page, matrix, sink);
    expect(sink.fills).toBeGreaterThan(0);
    expect(sink.strokes).toBeGreaterThan(0);
    expect(sink.saves).toBe(sink.restores); // balanced scope
  });

  it('emits a glyph run carrying decoded text', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], resources: HELV_RESOURCES, content: TEXT_CONTENT }));
    const page = doc.Pages[0];
    const { matrix } = baseMatrix(page, 'crop');
    const sink = new RecordingSink();
    interpret(doc, page, matrix, sink);
    expect(sink.glyphRuns.join('')).toContain('Hi');
  });
});
