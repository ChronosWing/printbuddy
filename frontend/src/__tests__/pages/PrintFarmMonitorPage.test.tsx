import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PrintFarmMonitorPage } from '../../pages/PrintFarmMonitorPage';

const printers = [
  {
    id: 1,
    name: 'Demo Bambu Lab P1S',
    serial_number: 'P1S123',
    ip_address: '10.0.0.11',
    access_code: '',
    provider: 'bambu',
    api_url: null,
    auth_token: null,
    provider_options: null,
    model: 'P1S',
    location: 'Rack A-01',
    nozzle_count: 1,
    is_active: true,
    auto_archive: true,
    external_camera_url: null,
    external_camera_type: null,
    external_camera_enabled: false,
    external_camera_snapshot_url: null,
    camera_rotation: 0,
    plate_detection_enabled: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'Demo Anycubic Kobra 2',
    serial_number: 'KOBRA2',
    ip_address: '10.0.0.12',
    access_code: '',
    provider: 'klipper',
    api_url: null,
    auth_token: null,
    provider_options: null,
    model: 'Generic FDM Printer',
    location: 'Rack C-02',
    nozzle_count: 1,
    is_active: true,
    auto_archive: true,
    external_camera_url: null,
    external_camera_type: null,
    external_camera_enabled: false,
    external_camera_snapshot_url: null,
    camera_rotation: 0,
    plate_detection_enabled: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

function statusFor(id: number) {
  if (id === 1) {
    return {
      id,
      name: 'Demo Bambu Lab P1S',
      connected: true,
      state: 'RUNNING',
      current_print: 'Gridfinity Calibration Tray',
      subtask_name: null,
      gcode_file: 'gridfinity.3mf',
      progress: 42,
      remaining_time: 94,
      layer_num: 84,
      total_layers: 198,
      temperatures: { nozzle: 218, bed: 60 },
      hms_errors: [],
      ams: [],
      ams_exists: false,
      vt_tray: [],
      supports_drying: false,
      awaiting_plate_clear: false,
    };
  }
  return {
    id,
    name: 'Demo Anycubic Kobra 2',
    connected: true,
    state: 'PAUSE',
    current_print: null,
    subtask_name: null,
    gcode_file: null,
    progress: null,
    remaining_time: null,
    layer_num: null,
    total_layers: null,
    temperatures: { nozzle: 29, bed: 28 },
    hms_errors: [],
    ams: [],
    ams_exists: false,
    vt_tray: [],
    supports_drying: false,
    awaiting_plate_clear: false,
  };
}

describe('PrintFarmMonitorPage', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-05-23T10:42:00Z'));
    vi.mocked(localStorage.getItem).mockReset();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
      http.get('/api/v1/printers/:id/status', ({ params }) => HttpResponse.json(statusFor(Number(params.id)))),
      http.get('/api/v1/queue/', () => HttpResponse.json([{ id: 1 }, { id: 2 }, { id: 3 }])),
      http.get('/api/v1/updates/version', () => HttpResponse.json({ version: '2.5.1', display_version: '2.5.1' })),
      http.get('/api/v1/settings/ui-preferences', () => HttpResponse.json({ print_farm_monitor_refresh_interval: 15 })),
      http.get('/api/v1/settings/', () => HttpResponse.json({ low_stock_threshold: 20 })),
      http.get('/api/v1/settings/spoolman', () => HttpResponse.json({ spoolman_enabled: 'false', spoolman_url: '', spoolman_sync_mode: 'read_only', spoolman_disable_weight_sync: 'false', spoolman_report_partial_usage: 'false' })),
      http.get('/api/v1/inventory/spools', () => HttpResponse.json([
        {
          id: 10,
          material: 'PLA',
          subtype: null,
          color_name: 'White',
          rgba: 'ffffff',
          extra_colors: null,
          effect_type: null,
          brand: 'RealFilament',
          label_weight: 1000,
          core_weight: 250,
          core_weight_catalog_id: null,
          weight_used: 910,
          slicer_filament: null,
          slicer_filament_name: null,
          nozzle_temp_min: null,
          nozzle_temp_max: null,
          note: null,
          added_full: true,
          last_used: null,
          encode_time: null,
          tag_uid: null,
          tray_uuid: null,
          data_origin: null,
          tag_type: null,
          archived_at: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          cost_per_kg: null,
          last_scale_weight: null,
          last_weighed_at: null,
          category: 'Production shelf',
          low_stock_threshold_pct: 15,
          storage_location: 'Shelf A',
        },
      ])),
      http.get('/api/v1/inventory/assignments', () => HttpResponse.json([
        {
          id: 1,
          spool_id: 10,
          printer_id: 1,
          printer_name: 'Demo Bambu Lab P1S',
          ams_id: -1,
          tray_id: 0,
          fingerprint_color: null,
          fingerprint_type: null,
          configured: true,
          created_at: '2024-01-01T00:00:00Z',
          spool: {
            id: 10,
            material: 'PLA',
            subtype: null,
            color_name: 'White',
            rgba: 'ffffff',
            extra_colors: null,
            effect_type: null,
            brand: 'RealFilament',
            label_weight: 1000,
            core_weight: 250,
            core_weight_catalog_id: null,
            weight_used: 910,
            slicer_filament: null,
            slicer_filament_name: null,
            nozzle_temp_min: null,
            nozzle_temp_max: null,
            note: null,
            added_full: true,
            last_used: null,
            encode_time: null,
            tag_uid: null,
            tray_uuid: null,
            data_origin: null,
            tag_type: null,
            archived_at: null,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            cost_per_kg: null,
            last_scale_weight: null,
            last_weighed_at: null,
            category: 'Production shelf',
            low_stock_threshold_pct: 15,
            storage_location: 'Shelf A',
          },
        },
      ])),
      http.get('/api/v1/maintenance/overview', () => HttpResponse.json([])),
      http.get('/api/v1/projects/', () => HttpResponse.json([
        {
          id: 42,
          name: 'Gridfinity Organizer Set',
          description: 'Modular storage system for workstations',
          color: '#3b82f6',
          status: 'active',
          target_count: 8,
          target_parts_count: 64,
          budget: null,
          created_at: '2024-01-01T00:00:00Z',
          archive_count: 4,
          total_items: 48,
          completed_count: 42,
          failed_count: 1,
          queue_count: 3,
          progress_percent: 50,
          archives: [],
          url: null,
          cover_image_filename: null,
        },
      ]))
    );
  });

  it('uses the compact TV layout at 1024 × 600 and keeps secondary panels available', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<PrintFarmMonitorPage />);

    expect(await screen.findByTestId('compact-farm-monitor')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('article', { name: /Demo Bambu Lab P1S printer/i })).toBeInTheDocument());
    expect(screen.getByTestId('compact-printer-grid')).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
    expect(screen.getByTestId('compact-printer-grid')).toHaveStyle({ gridTemplateRows: 'repeat(2, minmax(0, 1fr))' });
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByText('218°C')).toBeInTheDocument();
    expect(screen.getByText('60°C')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /Demo Bambu Lab P1S printer/i }).querySelector('img')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /Demo Bambu Lab P1S printer/i })).toHaveTextContent('Filament unavailable');
    expect(screen.getByRole('article', { name: /Demo Anycubic Kobra 2 printer/i })).toHaveTextContent('Filament unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Scan Filament' }));
    expect(screen.getByRole('dialog', { name: 'Scan filament' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('dialog', { name: 'Scan filament' }).querySelector('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Details for Demo Bambu Lab P1S' }));
    expect(screen.getByRole('dialog', { name: 'Demo Bambu Lab P1S details' })).toHaveTextContent('Loaded filament slots');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Farm Utilization')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Printers')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /alerts/i }));
    expect(screen.getByRole('dialog', { name: 'Farm alerts' })).toHaveTextContent('LOW FILAMENT');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /projects/i }));
    expect(screen.getByRole('dialog', { name: 'Active projects' })).toHaveTextContent('Gridfinity Organizer Set');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByRole('dialog', { name: 'Recent activity' })).toBeInTheDocument();
  });

  it('shows the physical low-stock spool without repeating its color in alerts', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    server.use(http.get('/api/v1/inventory/spools', () => HttpResponse.json([{
      id: 42, brand: 'Panchroma', material: 'PLA', subtype: 'Matte Foggy Purple',
      color_name: 'Matte Foggy Purple', rgba: '73518C', extra_colors: null,
      label_weight: 1000, weight_used: 900, archived_at: null,
      storage_location: 'U1', low_stock_threshold_pct: 20,
    }])));
    render(<PrintFarmMonitorPage />);
    fireEvent.click(await screen.findByRole('button', { name: /alerts/i }));
    const alerts = screen.getByRole('dialog', { name: 'Farm alerts' });
    expect(alerts).toHaveTextContent('Panchroma PLA Matte Foggy Purple');
    expect(alerts).not.toHaveTextContent('Matte Foggy Purple Matte Foggy Purple');
    expect(alerts).toHaveTextContent('10%');
  });

  it('shows the U1 physical spool once in the compact detail view', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([{ ...printers[0], name: 'Fixture U1', provider: 'moonraker', model: 'Snapmaker U1' }])),
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json({ ...statusFor(1), name: 'Fixture U1', tray_now: 1, ams: [{ id: 0, name: 'U1 toolheads', module_type: 'snapmaker_u1', tray: [{ id: 1, tray_type: 'PLA', tray_color: '73518CFF', spoolman_spool_id: 202, active: true }] }] })),
      http.get('/api/v1/settings/spoolman', () => HttpResponse.json({ spoolman_enabled: 'true', spoolman_url: 'http://fixture.invalid' })),
      http.get('/api/v1/spoolman/inventory/spools', () => HttpResponse.json([{ id: 202, brand: 'Panchroma', material: 'PLA', subtype: 'Matte Foggy Purple', color_name: 'Matte Foggy Purple', color_name_is_synthesized: true, rgba: '73518CFF', label_weight: 1000, weight_used: 940, archived_at: null }])),
      http.get('/api/v1/spoolman/inventory/slot-assignments/all', () => HttpResponse.json([{ printer_id: 1, ams_id: 0, tray_id: 1, spoolman_spool_id: 202 }])),
    );
    render(<PrintFarmMonitorPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Details for Fixture U1' }));
    const detail = screen.getByRole('dialog', { name: 'Fixture U1 details' });
    expect(detail).toHaveTextContent('Panchroma PLA Matte Foggy Purple');
    expect(detail).not.toHaveTextContent('Matte Foggy Purple Matte Foggy Purple');
    expect(detail).toHaveTextContent('Spool #202');
    expect(detail).toHaveTextContent('60 g');
    expect(detail).toHaveTextContent('6%');
  });

  it('makes every printer reachable in compact TV mode without a fixed eight-printer limit', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    server.use(http.get('/api/v1/printers/', () => HttpResponse.json(Array.from({ length: 10 }, (_, index) => ({ ...printers[0], id: index + 1, name: `Printer ${index + 1}` })))));
    render(<PrintFarmMonitorPage />);

    await waitFor(() => expect(screen.getByText('Printer 1')).toBeInTheDocument());
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Printer 6')).toBeInTheDocument();
    expect(screen.queryByText('Printer 7')).not.toBeInTheDocument();
    expect(screen.queryByText('Printer 10')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next printers' }));
    expect(screen.getByText('Printer 7')).toBeInTheDocument();
    expect(screen.getByText('Printer 10')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next printers' })).toBeDisabled();
  });

  it('reduces the compact grid to two columns and one row at 800 × 480', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 480 });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    server.use(http.get('/api/v1/printers/', () => HttpResponse.json(Array.from({ length: 6 }, (_, index) => ({ ...printers[0], id: index + 1, name: `Printer ${index + 1}` })))));
    render(<PrintFarmMonitorPage />);

    await waitFor(() => expect(screen.getByText('Printer 1')).toBeInTheDocument());
    expect(screen.getByTestId('compact-printer-grid')).toHaveStyle({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gridTemplateRows: 'repeat(1, minmax(0, 1fr))' });
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.queryByText('Printer 3')).not.toBeInTheDocument();
  });

  it('shows only the active slot on the compact card and all loaded slots in its read-only detail', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    server.use(http.get('/api/v1/printers/:id/status', ({ params }) => {
      const status = statusFor(Number(params.id));
      return HttpResponse.json(Number(params.id) === 1 ? {
        ...status, tray_now: 0, ams: [{ id: 0, name: 'AMS', tray: [
          { id: 0, tray_type: 'PLA', tray_color: '3377CC', remain: 72 },
          { id: 1, tray_type: 'PETG', tray_color: 'CC4433', remain: 10 },
        ] }],
      } : status);
    }));
    render(<PrintFarmMonitorPage />);

    const card = await screen.findByRole('article', { name: 'Demo Bambu Lab P1S printer' });
    await waitFor(() => expect(card).toHaveTextContent('PLA'));
    expect(card).not.toHaveTextContent('PETG');
    fireEvent.click(screen.getByRole('button', { name: 'Details for Demo Bambu Lab P1S' }));
    const detail = screen.getByRole('dialog', { name: 'Demo Bambu Lab P1S details' });
    expect(detail).toHaveTextContent('PLA');
    expect(detail).toHaveTextContent('PETG');
  });

  it('hides filament on an idle overview card but shows loaded slots in its detail', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    server.use(http.get('/api/v1/printers/:id/status', ({ params }) => {
      const status = statusFor(Number(params.id));
      return HttpResponse.json(Number(params.id) === 2 ? { ...status, state: 'IDLE', tray_now: 0, ams: [{ id: 0, name: 'AMS Lite', tray: [{ id: 0, tray_type: 'PLA', tray_color: '7755AA', remain: 66 }] }] } : status);
    }));
    render(<PrintFarmMonitorPage />);
    const card = await screen.findByRole('article', { name: 'Demo Anycubic Kobra 2 printer' });
    expect(card).not.toHaveTextContent('Filament');
    fireEvent.click(screen.getByRole('button', { name: 'Details for Demo Anycubic Kobra 2' }));
    expect(screen.getByRole('dialog', { name: 'Demo Anycubic Kobra 2 details' })).toHaveTextContent('PLA');
    expect(screen.queryByRole('region', { name: 'Current print' })).not.toBeInTheDocument();
  });

  it('switches layouts when the viewport becomes constrained and keeps all printers in large TV mode', async () => {
    const listeners = new Set<() => void>();
    const media = {
      matches: false,
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    server.use(http.get('/api/v1/printers/', () => HttpResponse.json(Array.from({ length: 10 }, (_, index) => ({ ...printers[0], id: index + 1, name: `Printer ${index + 1}` })))));
    render(<PrintFarmMonitorPage />);

    expect(await screen.findByText('Printer 10')).toBeInTheDocument();
    expect(screen.queryByTestId('compact-farm-monitor')).not.toBeInTheDocument();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    act(() => {
      media.matches = true;
      listeners.forEach((listener) => listener());
      fireEvent.resize(window);
    });
    expect(screen.getByTestId('compact-farm-monitor')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });

  it('renders the TV-style print farm overview from live printer status', async () => {
    render(<PrintFarmMonitorPage />);

    expect(await screen.findByRole('heading', { name: 'Print Farm Monitor' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Scan Filament' }));
    expect(screen.getByRole('dialog', { name: 'Scan filament' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('dialog', { name: 'Scan filament' }).querySelector('button')!);
    expect(screen.getByRole('link', { name: /back to farm command center/i })).toHaveAttribute('href', '/farm-command-center');
    expect(screen.getByText(new Date('2025-05-23T10:42:00Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))).toBeInTheDocument();
    expect(screen.getByText(new Date('2025-05-23T10:42:00Z').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('1 PRINTERS ACTIVE')).toBeInTheDocument());

    expect(screen.getByText(/total printers/i)).toBeInTheDocument();
    expect(screen.getByText(/printing now/i)).toBeInTheDocument();
    expect(screen.getByText(/queue size/i)).toBeInTheDocument();
    expect(screen.getByText('Gridfinity Calibration Tray')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getAllByText('PAUSED').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Demo Anycubic Kobra 2').length).toBeGreaterThan(0);
    expect(screen.getByText('ALERTS')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE PROJECTS')).toBeInTheDocument();
    expect(screen.getByText('Gridfinity Organizer Set')).toBeInTheDocument();
    expect(screen.getByText('42 / 64 parts')).toBeInTheDocument();
    expect(screen.getByText('3 queued')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
    expect(screen.getByText('LOW FILAMENT')).toBeInTheDocument();
    expect(screen.getAllByText(/RealFilament PLA White/).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('#FFFFFF');
    expect(document.body.textContent).not.toContain('Spool A1');
    expect(document.body.textContent).not.toContain('HEALTH OK');
    expect(screen.getByText('Recent Activity')).toBeInTheDocument();
    expect(document.body.textContent).toContain('PrintBuddy is operational');
    expect(document.body.textContent).toContain('every 15s');
    expect(document.body.textContent).toContain('Printbuddy');
    expect(document.body.textContent).toContain('v2.5.1');
  });

  it('uses fluid viewport-aware grids instead of fixed-width TV columns', async () => {
    render(<PrintFarmMonitorPage />);

    const heading = await screen.findByRole('heading', { name: 'Print Farm Monitor' });
    expect(heading.closest('main')).toHaveClass('overflow-x-hidden');
    expect(screen.getByTestId('farm-monitor-layout')).toHaveClass('min-w-0');
    expect(screen.getByTestId('farm-monitor-layout').className).toContain('min-[1280px]:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]');
    expect(screen.getByTestId('farm-monitor-layout')).toHaveClass('max-w-full');
    expect(screen.getByTestId('farm-monitor-main-column')).toContainElement(screen.getByTestId('farm-monitor-status-strip'));
    expect(screen.getByTestId('farm-monitor-main-column')).toContainElement(screen.getByTestId('farm-monitor-printer-grid'));
    expect(screen.getByTestId('farm-monitor-printer-grid')).toHaveClass('min-w-0');
    expect(screen.getByTestId('farm-monitor-printer-grid').className).toContain('grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))]');
    expect(screen.getByTestId('farm-monitor-sidebar')).toHaveClass('min-w-0');
    expect(screen.getByTestId('farm-monitor-sidebar')).toHaveClass('overflow-hidden');
  });

  it('shows the assigned Spoolman spool for the active AMS slot in TV mode', async () => {
    const activeAmsStatus = {
      ...statusFor(1),
      tray_now: 2,
      ams_exists: true,
      ams: [
        {
          id: 0,
          name: 'AMS-HT',
          humidity: 20,
          temp: 42,
          is_ams_ht: false,
          serial_number: 'AMSHT123',
          sw_ver: '1.0.0',
          dry_time: 0,
          dry_status: 0,
          dry_sub_status: 0,
          dry_sf_reason: [],
          module_type: 'n3f',
          tray: [
            { id: 0, tray_type: 'PLA', tray_sub_brands: null, tray_color: 'FFFFFFFF', tray_id_name: null, tray_info_idx: null, remain: 90, k: null, cali_idx: null, tag_uid: null, tray_uuid: null, nozzle_temp_min: null, nozzle_temp_max: null, drying_temp: null, drying_time: null, state: null },
            { id: 2, tray_type: 'ABS', tray_sub_brands: null, tray_color: '111111FF', tray_id_name: null, tray_info_idx: null, remain: 75, k: null, cali_idx: null, tag_uid: null, tray_uuid: null, nozzle_temp_min: null, nozzle_temp_max: null, drying_temp: null, drying_time: null, state: null },
          ],
        },
      ],
    };
    const sunluAbs = {
      id: 42,
      material: 'ABS',
      subtype: null,
      color_name: 'Black',
      rgba: '111111',
      extra_colors: null,
      effect_type: null,
      brand: 'Sunlu',
      label_weight: 1000,
      core_weight: 250,
      core_weight_catalog_id: null,
      weight_used: 250,
      slicer_filament: null,
      slicer_filament_name: null,
      nozzle_temp_min: null,
      nozzle_temp_max: null,
      note: null,
      added_full: true,
      last_used: null,
      encode_time: null,
      tag_uid: null,
      tray_uuid: null,
      data_origin: null,
      tag_type: null,
      archived_at: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      cost_per_kg: null,
      last_scale_weight: null,
      last_weighed_at: null,
      category: 'Production shelf',
      low_stock_threshold_pct: 15,
      storage_location: 'Shelf A',
    };

    server.use(
      http.get('/api/v1/printers/:id/status', ({ params }) => HttpResponse.json(Number(params.id) === 1 ? activeAmsStatus : statusFor(Number(params.id)))),
      http.get('/api/v1/settings/spoolman', () => HttpResponse.json({ spoolman_enabled: 'true', spoolman_url: 'http://spoolman.local', spoolman_sync_mode: 'read_only', spoolman_disable_weight_sync: 'false', spoolman_report_partial_usage: 'false' })),
      http.get('/api/v1/spoolman/inventory/spools', () => HttpResponse.json([sunluAbs])),
      http.get('/api/v1/spoolman/inventory/slot-assignments/all', () => HttpResponse.json([
        { printer_id: 1, printer_name: 'Demo Bambu Lab P1S', ams_id: 0, tray_id: 2, spoolman_spool_id: 42, ams_label: 'AMS-HT' },
      ])),
    );

    render(<PrintFarmMonitorPage />);

    await waitFor(() => expect(screen.getByText('1 PRINTERS ACTIVE')).toBeInTheDocument());
    expect(screen.getByText('Sunlu ABS Black')).toBeInTheDocument();
    expect(screen.getByText(/AMS 0 tray 2/)).toBeInTheDocument();
    expect(screen.getByText(/75%/)).toBeInTheDocument();
  });

  it('does not mark idle printers as printing when stale completed job metadata remains', async () => {
    server.use(
      http.get('/api/v1/printers/:id/status', ({ params }) => {
        const id = Number(params.id);
        if (id === 1) {
          return HttpResponse.json({
            id,
            name: 'Demo Bambu Lab P1S',
            connected: true,
            state: 'PRINTING',
            current_print: 'Finished Gridfinity Plate',
            subtask_name: null,
            gcode_file: 'finished-gridfinity-plate.gcode.3mf',
            progress: 100,
            remaining_time: 0,
            layer_num: 1228,
            total_layers: 1228,
            temperatures: { nozzle: 33, bed: 32 },
            hms_errors: [],
            ams: [],
            ams_exists: false,
            vt_tray: [],
            supports_drying: false,
            awaiting_plate_clear: false,
          });
        }
        return HttpResponse.json(statusFor(id));
      }),
    );

    render(<PrintFarmMonitorPage />);

    await screen.findAllByText('Demo Bambu Lab P1S');
    await waitFor(() => expect(screen.getByText('0 PRINTERS ACTIVE')).toBeInTheDocument());
    expect(screen.getAllByText('IDLE').length).toBeGreaterThan(0);
    expect(screen.queryByText('Finished Gridfinity Plate')).not.toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('1228 / 1228 layers');
  });

  it('does not render the current time as ETA when a running printer reports zero remaining time', async () => {
    server.use(
      http.get('/api/v1/printers/:id/status', ({ params }) => {
        const id = Number(params.id);
        if (id === 1) {
          return HttpResponse.json({
            ...statusFor(id),
            remaining_time: 0,
          });
        }
        return HttpResponse.json(statusFor(id));
      }),
    );

    render(<PrintFarmMonitorPage />);

    await waitFor(() => expect(screen.getByText('1 PRINTERS ACTIVE')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('ETA 10:42 AM');
    expect(document.body.textContent).toContain('ETA —');
  });

  it('follows the selected PrintBuddy light theme', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => (
      key === 'theme-mode' ? 'light' : null
    ));

    render(<PrintFarmMonitorPage />);

    const heading = await screen.findByRole('heading', { name: 'Print Farm Monitor' });
    const monitor = heading.closest('main');
    expect(monitor).toHaveAttribute('data-monitor-theme', 'light');
    expect(monitor).toHaveClass('bg-bambu-dark');
    expect(screen.getByAltText('Printbuddy')).toHaveAttribute('src', '/img/printbuddy_logo_light.png');
  });
});
