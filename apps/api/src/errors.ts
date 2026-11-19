/** An expected failure with a stable code that API clients can branch on. */
export class LedgerError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export const notFound = (what: string) => new LedgerError('not_found', 404, `${what} not found`);
export const badRequest = (code: string, message: string) => new LedgerError(code, 400, message);
export const conflict = (code: string, message: string) => new LedgerError(code, 409, message);
export const unprocessable = (code: string, message: string) => new LedgerError(code, 422, message);
