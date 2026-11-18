/** Optional per-job work hooks. Font parsers remain independent of the PS VM. */
export interface FontWork {
  work(count?: number, detail?: string): void;
  allocate(bytes: number, detail?: string): void;
  items(reached: number, detail?: string): void;
  depth(reached: number, detail?: string): void;
}
