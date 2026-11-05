// Prefix physical lines as their first bytes arrive. No line buffering: partial
// model output stays live, and split UTF-8 bytes are preserved verbatim.
export function timestampLines(now = () => new Date().toISOString()) {
  let atLineStart = true;
  return chunk => {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const parts = [];
    let start = 0;
    for (let i = 0; i < input.length; i++) {
      if (atLineStart) {
        parts.push(Buffer.from(`[${now()}] `));
        atLineStart = false;
      }
      if (input[i] === 10) {
        parts.push(input.subarray(start, i + 1));
        start = i + 1;
        atLineStart = true;
      }
    }
    if (start < input.length) parts.push(input.subarray(start));
    return Buffer.concat(parts);
  };
}

export const timestampLine = text => timestampLines()(text).toString('utf8');
