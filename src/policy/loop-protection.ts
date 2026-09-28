import { hash } from '../database/sqlite.js';
export function fingerprint(text: string) {
  return hash(
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]/gu, ''),
  );
}
// Deterministic lexical similarity is a conservative approximation, never an LLM claim.
export function similarity(a: string, b: string) {
  const grams = (s: string) => {
    const t = s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    return new Set(Array.from({ length: Math.max(0, t.length - 2) }, (_, i) => t.slice(i, i + 3)));
  };
  const x = grams(a),
    y = grams(b);
  if (!x.size || !y.size) return a === b ? 1 : 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return n / (x.size + y.size - n);
}
