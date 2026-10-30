import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { SpoolmanScanDialog } from '../../components/SpoolmanScanDialog';

const spool = { id: 123, material: 'PLA', subtype: 'Long Color Name', slicer_filament_name: 'Very Long Example Filament Name', brand: 'Example Maker', color_name: 'Rainbow', rgba: 'FF0000FF', extra_colors: '00FF00,0000FF', label_weight: 1000, weight_used: 250, storage_location: 'Shelf A', archived_at: null };

describe('Spoolman scan dialog', () => {
  it('looks up a physical spool and shows its inventory details', async () => {
    let count = 0;
    server.use(http.get('/api/v1/spoolman/inventory/spools/123', () => { count++; return HttpResponse.json(spool); }));
    render(<SpoolmanScanDialog onClose={vi.fn()} assignments={[{ printer_name: 'Printer A', ams_label: 'AMS', ams_id: 0, tray_id: 1, spoolman_spool_id: 123 }]} />);
    fireEvent.change(screen.getByPlaceholderText('WEB+SPOOLMAN:S-123'), { target: { value: 'WEB+SPOOLMAN:S-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up label' }));
    expect(await screen.findByText('750 g')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('Multicolor · 3 colors')).toBeInTheDocument();
    expect(screen.getByText(/Printer A/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Look up label' }));
    await waitFor(() => expect(count).toBe(1));
  });
  it('rejects filament labels and reports missing spools', async () => {
    server.use(http.get('/api/v1/spoolman/inventory/spools/456', () => new HttpResponse(null, { status: 404 })));
    render(<SpoolmanScanDialog onClose={vi.fn()} assignments={[]} />);
    const field = screen.getByPlaceholderText('WEB+SPOOLMAN:S-123');
    fireEvent.change(field, { target: { value: 'WEB+SPOOLMAN:F-456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up label' }));
    expect(screen.getByRole('alert')).toHaveTextContent('not a supported');
    expect(screen.getByRole('alert')).toHaveClass('text-red-900', 'dark:text-red-100');
    fireEvent.change(field, { target: { value: 'https://example.com/spool/show/456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up label' }));
    expect(await screen.findByText('Physical spool #456 was not found.')).toBeInTheDocument();
  });
  it('supports manual lookup, unavailable service, and another scan', async () => {
    server.use(
      http.get('/api/v1/spoolman/inventory/spools/123', () => HttpResponse.json({ ...spool, spoolman_archived: true, spoolman_remaining_known: false, spoolman_nominal_weight_known: false })),
      http.get('/api/v1/spoolman/inventory/spools/999', () => new HttpResponse(null, { status: 503 })),
    );
    render(<SpoolmanScanDialog onClose={vi.fn()} assignments={[]} />);
    fireEvent.change(screen.getByPlaceholderText('Spool ID'), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find spool' }));
    expect(await screen.findByText(/Physical spool #123 · Archived/)).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Scan another' }));
    fireEvent.change(screen.getByPlaceholderText('WEB+SPOOLMAN:S-123'), { target: { value: 'WEB+SPOOLMAN:S-999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up label' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Spoolman is unavailable');
  });
});
