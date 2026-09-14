// Standalone, pure SSE (Server-Sent Events) parser for OpenAI/vLLM-style
// streaming responses. Kept free of any fetch/DOM dependency so it can be
// unit-tested in isolation.
//
// Framing rules implemented:
//  - events are separated by a blank line ("\n\n")
//  - each event is made of one or more lines; only lines starting with
//    "data:" carry the payload we care about
//  - the stream ends with a literal "data: [DONE]" event
//  - a chunk boundary from the network can split an event (or even a single
//    JSON payload) in the middle, so callers must carry a `buffer` forward
//    across reads and feed it back in on the next call

export interface SseParseResult {
  /** Raw `data:` payload strings for this chunk, in order. Never includes "[DONE]". */
  events: string[];
  /** Left-over text that did not yet form a complete event; feed back into the next call. */
  remainder: string;
  /** True if a "data: [DONE]" event was seen in this chunk. */
  done: boolean;
}

/**
 * Parse one more piece of an SSE stream.
 *
 * @param buffer left-over text from the previous call (start with "" for a fresh stream)
 * @param chunk  newly received text to append to the buffer before parsing
 */
export function parseSseChunk(buffer: string, chunk: string): SseParseResult {
  // Normalise CRLF framing to LF. The SSE spec permits "\r\n\r\n" as an event
  // separator; raw CR/LF never appear inside a JSON payload (they are escaped),
  // so this is safe to do before splitting.
  const combined = (buffer + chunk).replace(/\r\n/g, "\n");
  const segments = combined.split("\n\n");
  // The last segment is either empty (if `combined` ended with "\n\n") or an
  // incomplete event; either way it must be carried forward, not parsed yet.
  const remainder = segments.pop() ?? "";

  const events: string[] = [];
  let done = false;

  for (const segment of segments) {
    const lines = segment.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trimStart();
      if (payload.length === 0) continue;
      if (payload === "[DONE]") {
        done = true;
        continue;
      }
      events.push(payload);
    }
  }

  return { events, remainder, done };
}

/**
 * Flush whatever is left in `buffer` at the end of a stream (e.g. the server
 * closed the connection without a trailing blank line after the last event).
 * Reuses `parseSseChunk` by feeding it a closing "\n\n".
 */
export function flushSseBuffer(buffer: string): SseParseResult {
  if (buffer.trim().length === 0) {
    return { events: [], remainder: "", done: false };
  }
  return parseSseChunk(buffer, "\n\n");
}
