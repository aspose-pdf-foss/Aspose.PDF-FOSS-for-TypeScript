export class PdfParseError extends Error {
  constructor(message: string, readonly offset?: number) {
    super(offset === undefined ? message : `${message} (at byte ${offset})`);
    this.name = 'PdfParseError';
  }
}
export class UnsupportedFeatureError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedFeatureError'; }
}
export class InvalidPasswordError extends Error {
  constructor(message = 'PDF is password-protected: wrong or missing password') {
    super(message); this.name = 'InvalidPasswordError';
  }
}
