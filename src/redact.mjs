// Remove anything that looks like a credential from text we print or put in PR bodies.
const PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s'"]+/gi,
  /((?:token|secret|password|passwd|api[_-]?key|privkey|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s'",}]{8,}/gi,
];

export function redact(text) {
  let s = String(text ?? '');
  for (const re of PATTERNS) s = s.replace(re, (m, p1) => (typeof p1 === 'string' && m.startsWith(p1) ? `${p1}[redacted]` : '[redacted]'));
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 12 && /TOKEN|SECRET|KEY|PASSWORD|PAT/i.test(k)) s = s.split(v).join('[redacted]');
  }
  return s;
}

export const SECRET_PATTERNS = PATTERNS.slice(0, 6);
