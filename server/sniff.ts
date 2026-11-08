// What a file is, from its first bytes: a file is taken only when its bytes are the type it was sent as, so a page
// renamed to .png is refused. Text must be UTF-8 with no control characters but tabs and line breaks.

const starts = (b: Buffer, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

export function sniff(b: Buffer): string | null {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(b, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return plainText(b) ? "text/plain" : null;
}

function plainText(b: Buffer): boolean {
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return false;
  }
  // Markup is not plain text: a browser that ignored the type could run it.
  if (/<\s*(script|html|svg|iframe|body|!doctype)/i.test(s.slice(0, 4096))) return false;
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
}
