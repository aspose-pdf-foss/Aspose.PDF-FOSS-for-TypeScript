export declare class BioWriter {
  putbit(b: number): void;
  write(v: number, n: number): void;
  flush(): Uint8Array;
}
export declare function writePassCount(bw: BioWriter, n: number): void;
export declare class TagTreeEnc {
  constructor(w: number, h: number);
  setLeaf(i: number, j: number, v: number): void;
  build(): void;
  encode(bw: BioWriter, i: number, j: number, threshold: number): void;
}
export declare function relayer(j2k: Uint8Array, nLayers: number): Uint8Array;
