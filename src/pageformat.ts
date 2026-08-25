/** A page size in points (1/72"). Immutable. A Go-parity abstraction shared by
 *  blank-page creation ({@link Document.AddPage}/{@link Document.InsertPage}) and
 *  the {@link Flow} layout container, so callers name a size instead of passing
 *  raw width/height. */
export class PageFormat {
  private constructor(readonly width: number, readonly height: number) {}

  static readonly A4 = new PageFormat(595, 842);
  static readonly Letter = new PageFormat(612, 792);
  static readonly Legal = new PageFormat(612, 1008);

  /** A custom page size; both dimensions must be positive and finite. */
  static custom(width: number, height: number): PageFormat {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw new TypeError('PageFormat.custom: width and height must be positive finite numbers');
    return new PageFormat(width, height);
  }

  /** This format oriented so width >= height (returns `this` if already so). */
  landscape(): PageFormat {
    return this.width >= this.height ? this : new PageFormat(this.height, this.width);
  }

  /** This format oriented so height >= width (returns `this` if already so). */
  portrait(): PageFormat {
    return this.height >= this.width ? this : new PageFormat(this.height, this.width);
  }

  /** The `/MediaBox` rectangle `[0, 0, width, height]` for this format. */
  mediaBox(): number[] {
    return [0, 0, this.width, this.height];
  }
}
