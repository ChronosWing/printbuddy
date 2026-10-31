import type { InventorySpool } from '../api/client';

type SpoolNameParts = Pick<InventorySpool, 'brand' | 'material' | 'subtype' | 'color_name' | 'color_name_is_synthesized'>;

function clean(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

// Compare complete words in metadata fields; never rewrite words in an original name.
function words(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function startsWithWords(value: string, prefix: string): boolean {
  const a = words(value);
  const b = words(prefix);
  return b.length > 0 && b.length <= a.length && b.every((word, index) => a[index] === word);
}

function endsWithWords(value: string, suffix: string): boolean {
  const a = words(value);
  const b = words(suffix);
  return b.length > 0 && b.length <= a.length && b.every((word, index) => a[a.length - b.length + index] === word);
}

/** Compose a display label without repeating metadata already present in another field. */
export function formatFilamentDescription(spool: SpoolNameParts): string {
  const brand = clean(spool.brand);
  const material = clean(spool.material);
  const subtype = clean(spool.subtype);
  const color = clean(spool.color_name);

  const parts: string[] = [];
  const subtypeIncludesIdentity = brand && material && startsWithWords(subtype, `${brand} ${material}`);
  if (brand && !startsWithWords(material, brand) && !startsWithWords(subtype, brand)) parts.push(brand);
  if (material && !subtypeIncludesIdentity && !startsWithWords(subtype, material)) parts.push(material);
  if (subtype) parts.push(subtype);
  const base = parts.join(' ');
  if (color && (!spool.color_name_is_synthesized || !subtype) && !endsWithWords(base, color)) parts.push(color);
  return parts.join(' ') || 'Filament details unavailable';
}
