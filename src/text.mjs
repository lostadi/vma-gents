export function boundedUtf8Tail(value, maxBytes) {
  const full = Buffer.from(value, "utf8");
  if (full.length <= maxBytes) {
    return { text: value, truncated: false, totalBytes: full.length };
  }

  let start = full.length - maxBytes;
  while (start < full.length && (full[start] & 0xc0) === 0x80) start += 1;
  return {
    text: full.subarray(start).toString("utf8"),
    truncated: true,
    totalBytes: full.length,
  };
}
