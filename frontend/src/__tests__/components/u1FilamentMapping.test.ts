import { describe, expect, it } from 'vitest';
import { buildU1AutoMapping, u1ColorHex } from '../../components/PrintModal/u1FilamentMapping';

describe('U1 filament mapping', () => {
  it('matches loaded material and color before logical tool number', () => {
    const mapping = buildU1AutoMapping(
      [0, 2],
      ['PLA', '', 'PETG', ''],
      ['#FF0000', '', '#0000FF', ''],
      [
        { id: 0, filament_detected: true, tray_type: 'PETG', tray_color: '0000FFFF' },
        { id: 1, filament_detected: true, tray_type: 'PLA', tray_color: 'FF0000FF' },
        { id: 2, filament_detected: false, tray_type: 'PLA', tray_color: 'FF0000FF' },
      ],
    );
    expect(mapping).toEqual({ 0: 1, 2: 0 });
  });

  it('leaves an empty toolhead visible when no loaded match exists', () => {
    expect(buildU1AutoMapping([0, 1], ['PLA', 'PETG'], [], [
      { id: 0, filament_detected: true, tray_type: 'PLA' },
      { id: 1, filament_detected: false, tray_type: 'PETG' },
    ])).toEqual({ 0: 0, 1: 1 });
  });

  it('normalizes six and eight digit filament colors', () => {
    expect(u1ColorHex('aabbccFF')).toBe('#AABBCC');
    expect(u1ColorHex('#AABBCC')).toBe('#AABBCC');
    expect(u1ColorHex('unknown')).toBeNull();
  });
});
