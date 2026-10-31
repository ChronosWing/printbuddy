import { describe, expect, it } from 'vitest';
import { formatFilamentDescription } from '../../utils/filamentDescription';

const label = (brand: string | null, material: string, subtype: string | null, color_name: string | null, color_name_is_synthesized = false) =>
  formatFilamentDescription({ brand, material, subtype, color_name, color_name_is_synthesized });

describe('formatFilamentDescription', () => {
  it.each([
    ['Bambu Lab', 'PLA', 'Basic Red', 'Basic Red', 'Bambu Lab PLA Basic Red'],
    ['KINGROON', 'PETG', 'Black', 'Black', 'KINGROON PETG Black'],
    ['Panchroma', 'PLA', 'Matte Foggy Purple', 'Matte Foggy Purple', 'Panchroma PLA Matte Foggy Purple'],
    ['Bambu Lab', 'PLA', 'Basic Red', 'Red', 'Bambu Lab PLA Basic Red'],
    ['Bambu Lab', 'PLA', 'Basic', 'Red', 'Bambu Lab PLA Basic Red'],
    ['Maker', 'PLA', 'Silk', 'Blue / Green', 'Maker PLA Silk Blue / Green'],
    [null, 'PETG', 'Translucent', 'Amber', 'PETG Translucent Amber'],
    ['Maker', '', 'Silk', null, 'Maker Silk'],
    ['Maker', 'PLA', 'Red Red', 'Red', 'Maker PLA Red Red'],
    ['Maker', 'PLA', 'Blackout', 'Black', 'Maker PLA Blackout Black'],
    [' Maker  ', ' PLA ', ' Matte: Foggy   Purple ', 'Foggy Purple', 'Maker PLA Matte: Foggy Purple'],
    ['Bambu Lab', 'PLA', 'Bambu Lab PLA Basic Red', 'Red', 'Bambu Lab PLA Basic Red'],
  ])('formats %s %s %s %s', (brand, material, subtype, color, expected) => {
    expect(label(brand, material, subtype, color)).toBe(expected);
  });

  it('uses synthesized color only when no subtype is available', () => {
    expect(label('KINGROON', 'PETG', 'Black', 'Black', true)).toBe('KINGROON PETG Black');
    expect(label(null, 'PLA', null, 'Rainbow', true)).toBe('PLA Rainbow');
  });

  it('never produces a blank label', () => {
    expect(label(null, '', null, null)).toBe('Filament details unavailable');
  });
});
