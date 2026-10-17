import type { Response } from "express";

/**
 * The refusal body the routes share: `error` is the sentence a person reads,
 * `code` the machine-readable reason the UI can switch on instead of matching
 * prose. Each route pins `C` to its own code union with a one-line alias
 * (`const fail = sendError<BoardErrorCode>;`), so a misspelt code is a compile
 * error in that route rather than a string nobody handles.
 */
export function sendError<C extends string>(res: Response, status: number, code: C, error: string): void {
  res.status(status).json({ error, code });
}
