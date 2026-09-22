/**
 * Normalize / extract email-change verification tokens from raw paste or deep-link params.
 * Accepts raw tokens or full https:// / grabdocs:// links with ?token= or #token=.
 */
export function extractEmailChangeToken(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') return '';

  let s = value.trim();
  if (!s) return '';

  const looksLikeLink =
    /token=/i.test(s) ||
    /verify-email-change/i.test(s) ||
    /^https?:/i.test(s) ||
    /^grabdocs:/i.test(s);

  if (looksLikeLink) {
    // Query (?token= / &token=) or hash (#token=) — prefer regex so hash is not missed
    // when URL.searchParams is empty.
    const fromRegex =
      s.match(/[?&]token=([^&\s#]+)/i)?.[1] ||
      s.match(/#token=([^&\s]+)/i)?.[1] ||
      null;

    if (fromRegex) {
      s = fromRegex;
    } else {
      try {
        const normalized = /^grabdocs:/i.test(s)
          ? s.replace(/^grabdocs:/i, 'https:')
          : s;
        if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
          const url = new URL(normalized);
          const fromQuery = url.searchParams.get('token');
          if (fromQuery) {
            s = fromQuery;
          } else if (url.hash) {
            const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
            const fromHash = hashParams.get('token');
            if (fromHash) s = fromHash;
          }
        }
      } catch {
        // keep as-is; validated below
      }
    }

    // Still a URL / path with no extractable token — do not POST the whole string.
    if (
      /^https?:/i.test(s) ||
      /^grabdocs:/i.test(s) ||
      /verify-email-change/i.test(s) ||
      /[?&#]/i.test(s)
    ) {
      return '';
    }
  }

  s = s.trim().replace(/ /g, '+');
  try {
    s = decodeURIComponent(s);
  } catch {
    // keep as-is
  }
  return s;
}

/** Permanent failures: token is burned or invalid — safe to cache. Transient (network/5xx) must retry. */
export function isPermanentEmailChangeFailure(message: string): boolean {
  const m = (message || '').toLowerCase();
  return (
    m.includes('invalid') ||
    m.includes('expired') ||
    m.includes('already in use') ||
    m.includes('already used') ||
    m.includes('already been used') ||
    m.includes('cancelled') ||
    m.includes('canceled') ||
    m.includes('token is required') ||
    m.includes('verification token is required') ||
    m.includes('user not found')
  );
}
