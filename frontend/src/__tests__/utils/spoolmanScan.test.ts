import { describe, expect, it } from 'vitest';
import { parseSpoolmanSpoolId } from '../../utils/spoolmanScan';

describe('physical Spoolman label parsing', () => {
  it.each([
    ['WEB+SPOOLMAN:S-123', 123],
    ['web+spoolman:s-3', 3],
    ['https://spoolman.example/spool/show/123', 123],
    ['http://spoolman.example/spool/show/42/', 42],
  ])('reads %s as spool %i', (payload, id) => expect(parseSpoolmanSpoolId(payload)).toBe(id));
  it.each(['WEB+SPOOLMAN:F-123', 'WEB+SPOOLMAN:L-123', 'WEB+SPOOLMAN:CLEAR', '123', 'https://example.com/filament/show/123', 'https://example.com/spool/show/123?other=1', 'https://example.com/spool/show/0', 'https://example.com/spool/show/12/other', 'WEB+SPOOLMAN:S-99999999999999999999999'])('rejects %s', (payload) => expect(parseSpoolmanSpoolId(payload)).toBeNull());
  it('accepts bare positive IDs only in manual mode', () => expect(parseSpoolmanSpoolId('123', true)).toBe(123));
});
