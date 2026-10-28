type U1Tray = { id: number; filament_detected?: boolean; tray_type?: string | null; tray_color?: string | null };

export function u1ColorHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '').slice(0, 6);
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}

const material = (value: unknown) => typeof value === 'string' ? value.trim().toUpperCase() : '';

export function buildU1AutoMapping(
  usedTools: number[],
  types: unknown[],
  colors: unknown[],
  trays: U1Tray[],
): Record<number, number> {
  const mapping: Record<number, number> = {};
  const assigned = new Set<number>();
  const loaded = trays.filter((tray) => tray.filament_detected && tray.id >= 0 && tray.id < 4);
  const remaining = () => usedTools.filter((logical) => mapping[logical] === undefined);
  const assign = (matches: (logical: number, tray: U1Tray) => boolean) => {
    for (const logical of remaining()) {
      const tray = loaded.find((candidate) => !assigned.has(candidate.id) && matches(logical, candidate));
      if (tray) {
        mapping[logical] = tray.id;
        assigned.add(tray.id);
      }
    }
  };

  assign((logical, tray) => Boolean(material(types[logical])) && material(types[logical]) === material(tray.tray_type) &&
    Boolean(u1ColorHex(colors[logical])) && u1ColorHex(colors[logical]) === u1ColorHex(tray.tray_color));
  assign((logical, tray) => Boolean(material(types[logical])) && material(types[logical]) === material(tray.tray_type));
  assign((logical, tray) => !material(types[logical]) && Boolean(u1ColorHex(colors[logical])) &&
    u1ColorHex(colors[logical]) === u1ColorHex(tray.tray_color));
  assign((logical, tray) => logical === tray.id);
  assign(() => true);

  // Keep an unassigned sliced slot visible as an empty toolhead, where the
  // dialog can explain the missing filament and block print submission.
  for (const logical of remaining()) {
    const physical = [logical, 0, 1, 2, 3].find((id) => id >= 0 && id < 4 && !assigned.has(id));
    if (physical !== undefined) {
      mapping[logical] = physical;
      assigned.add(physical);
    }
  }
  return mapping;
}
