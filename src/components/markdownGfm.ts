import remarkGfm, { type Options } from "remark-gfm";

/**
 * GFM, minus the single-tilde strikethrough.
 *
 * Korean answers use "~" for ranges all the time ("10~20일", "3~5만 원"), and two
 * of them in one paragraph were read as ~strike~ and drew a line through the
 * text in between. A deliberate strikethrough is written ~~like this~~, which
 * still works.
 */
export const gfm: [typeof remarkGfm, Options] = [remarkGfm, { singleTilde: false }];
