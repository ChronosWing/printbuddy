type Props = { colors?: Array<string | null | undefined>; size?: number; label?: string };

/** A lightweight reel, with filament shown through the openings in its flanges. */
export function FilamentSpoolGraphic({ colors = [], size = 76, label = 'Filament spool' }: Props) {
  const valid = colors.filter((color): color is string => Boolean(color && /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)))
    .map((color) => `#${color.replace('#', '').slice(0, 6)}`);
  const id = `filament-${valid.join('-').replaceAll('#', '') || 'unknown'}`;
  const segments = valid.length ? valid : ['#777f89'];
  return <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={label} className="shrink-0 drop-shadow-md">
    <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1">{segments.map((color, index) => <stop key={`${color}-${index}`} offset={`${index * 100 / segments.length}%`} stopColor={color} />)}<stop offset="100%" stopColor={segments[segments.length - 1]} /></linearGradient></defs>
    <circle cx="50" cy="50" r="46" fill="#303741" stroke="#aeb8c5" strokeWidth="3" />
    <circle cx="50" cy="50" r="38" fill={`url(#${id})`} stroke="#202732" strokeWidth="2" />
    {segments.length > 1 && segments.map((color, index) => <path key={`${color}-${index}`} d={`M50 50 L${50 + 37 * Math.cos(index * 2 * Math.PI / segments.length)} ${50 + 37 * Math.sin(index * 2 * Math.PI / segments.length)} A37 37 0 0 1 ${50 + 37 * Math.cos((index + 1) * 2 * Math.PI / segments.length)} ${50 + 37 * Math.sin((index + 1) * 2 * Math.PI / segments.length)} Z`} fill={color} />)}
    <circle cx="50" cy="50" r="15" fill="#aab4c1" stroke="#e2e8f0" strokeWidth="3" />
    <circle cx="50" cy="50" r="8" fill="#202732" />
    <path d="M26 20 Q50 4 74 20 M20 74 Q50 95 80 74" fill="none" stroke="#e2e8f0" strokeWidth="5" strokeLinecap="round" />
    <circle cx="28" cy="50" r="4" fill="#e2e8f0" /><circle cx="72" cy="50" r="4" fill="#e2e8f0" />
  </svg>;
}
