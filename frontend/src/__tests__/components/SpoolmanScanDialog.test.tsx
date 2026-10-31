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
    expect(await screen.findByText('750 g remaining')).toBeInTheDocument();
    expect(screen.getByText('75% remaining')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Physical spool 123 filament reel' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Filament remaining' })).toHaveAttribute('aria-valuenow', '75');
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
    expect(await screen.findByText(/physical spool #123/i)).toBeInTheDocument();
    expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Scan another' }));
    fireEvent.change(screen.getByPlaceholderText('WEB+SPOOLMAN:S-123'), { target: { value: 'WEB+SPOOLMAN:S-999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up label' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Spoolman is unavailable');
  });
  it('confirms an occupied slot only after physical replacement acknowledgment', async () => {
    let submissions = 0;
    server.use(
      http.get('/api/v1/spoolman/inventory/spools/123', () => HttpResponse.json(spool)),
      http.get('/api/v1/spoolman/inventory/confirmed-assignments/preview', () => HttpResponse.json({ printers: [{ printer_id: 7, name: 'Printer A', slots: [{ ams_id: 0, tray_id: 2, label: 'T2', current_spool_id: 44, fingerprint: 'slot-44', replacement_required: true, available: true, reason: null, mechanism: 'u1_native' }, { ams_id: 0, tray_id: 3, label: 'T3', current_spool_id: null, fingerprint: 'slot-empty', replacement_required: false, available: true, reason: null, mechanism: 'u1_native' }] }] })),
      http.post('/api/v1/spoolman/inventory/confirmed-assignments', async () => { submissions++; return HttpResponse.json({ outcome: 'success', printer_side: 'verified', printbuddy: 'firmware_mirror', location: 'synchronized' }); }),
    );
    render(<SpoolmanScanDialog onClose={vi.fn()} assignments={[]} />);
    fireEvent.change(screen.getByPlaceholderText('Spool ID'), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find spool' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Assign to Printer' }));
    await screen.findByRole('option', { name: 'Printer A' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Printer' }), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /T2.*Occupied/i }));
    expect(screen.getByRole('img', { name: 'Existing filament reel' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Replacement filament reel' })).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm assignment' });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirm).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /T3.*Available/i }));
    fireEvent.click(screen.getByRole('button', { name: /T2.*Occupied/i }));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh destinations' }));
    expect(screen.queryByRole('button', { name: 'Confirm assignment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /T2.*Occupied/i }));
    const refreshedConfirm = screen.getByRole('button', { name: 'Confirm assignment' });
    expect(refreshedConfirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(refreshedConfirm);
    fireEvent.click(refreshedConfirm);
    await waitFor(() => expect(submissions).toBe(1));
    expect(await screen.findByText('Spoolman location')).toBeInTheDocument();
    expect(screen.getByText('PrintBuddy inventory mirror')).toBeInTheDocument();
  });
  it('shows unsafe destinations and keeps read-only lookup available', async () => {
    server.use(
      http.get('/api/v1/spoolman/inventory/spools/123', () => HttpResponse.json(spool)),
      http.get('/api/v1/spoolman/inventory/confirmed-assignments/preview', () => HttpResponse.json({ printers: [{ printer_id: 7, name: 'Offline', slots: [{ ams_id: 0, tray_id: 0, label: 'T0', current_spool_id: null, fingerprint: 'offline', replacement_required: false, available: false, reason: 'Printer disconnected', mechanism: 'u1_native' }] }] })),
    );
    render(<SpoolmanScanDialog onClose={vi.fn()} assignments={[]} />);
    fireEvent.change(screen.getByPlaceholderText('Spool ID'), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find spool' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Assign to Printer' }));
    await screen.findByRole('option', { name: 'Offline' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Printer' }), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /T0.*Unavailable/i }));
    expect(screen.getByRole('button', { name: 'Confirm assignment' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Printer disconnected');
  });
});
