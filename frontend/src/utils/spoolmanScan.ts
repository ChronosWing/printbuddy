/** Decode only a physical Spoolman spool reference. Never follow a scanned URL. */
export function parseSpoolmanSpoolId(value: string, allowBareId = false): number | null {
  const raw = value.trim();
  let digits: string | undefined;
  const scheme = /^web\+spoolman:s-([1-9]\d*)$/i.exec(raw);
  if (scheme) digits = scheme[1];
  else if (allowBareId && /^[1-9]\d*$/.test(raw)) digits = raw;
  else {
    try {
      const url = new URL(raw);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash) {
        digits = /^\/spool\/show\/([1-9]\d*)\/?$/i.exec(url.pathname)?.[1];
      }
    } catch { /* Unsupported QR payload. */ }
  }
  const id = digits ? Number(digits) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
