import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ScanLine,
  ArrowLeft,
  Bell,
  CheckCircle2,
  CirclePause,
  Clock3,
  Layers,
  PackageOpen,
  PauseCircle,
  PlayCircle,
  Power,
  Printer as PrinterIcon,
  RefreshCw,
  Server,
  Thermometer,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import {
  api,
  type InventorySpool,
  type MaintenanceStatus,
  type PrintQueueItem,
  type ProjectListItem,
  type Printer,
  type PrinterMaintenanceOverview,
  type PrinterStatus,
  type SpoolAssignment,
} from '../api/client';
import { getPrinterImage } from '../utils/printer';
import { formatFilamentDescription } from '../utils/filamentDescription';
import { classifyPrinterStatus } from '../utils/printerStatus';
import { appAssetPath } from '../utils/assetPaths';
import { getGlobalTrayId, resolveLoadedFilamentInfo, type ResolvedLoadedFilamentInfo, type SpoolmanSlotAssignmentLike } from '../utils/amsHelpers';
import { useTheme } from '../contexts/ThemeContext';
import { SpoolmanScanDialog } from '../components/SpoolmanScanDialog';

interface MonitorPrinter {
  printer: Printer;
  status?: PrinterStatus;
}

type NormalizedState = 'printing' | 'idle' | 'paused' | 'stopped' | 'offline' | 'error';

interface MonitorAlert {
  icon: typeof AlertTriangle;
  title: string;
  detail: string;
  sub: string;
  meta: string;
  tone: string;
}

interface MonitorThemeClasses {
  page: string;
  backdrop: string;
  panel: string;
  panelSoft: string;
  card: string;
  text: string;
  muted: string;
  subtle: string;
  border: string;
  divider: string;
  imageBox: string;
  footer: string;
  ringInner: string;
  logoPath: string;
}

const DEFAULT_REFRESH_SECONDS = 15;
const COMPACT_VIEWPORT = '(max-width: 1100px) and (max-height: 700px)';

function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(COMPACT_VIEWPORT).matches || false);
  useEffect(() => {
    const media = window.matchMedia?.(COMPACT_VIEWPORT);
    if (!media) return;
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}

function getMonitorTheme(mode: 'dark' | 'light'): MonitorThemeClasses {
  return {
    page: 'bg-bambu-dark text-white',
    backdrop: 'bg-bambu-dark',
    panel: 'border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-[var(--card-shadow)]',
    panelSoft: 'border-bambu-dark-tertiary bg-bambu-dark-secondary',
    card: 'border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-[var(--card-shadow)]',
    text: 'text-white',
    muted: 'text-bambu-gray-light',
    subtle: 'text-bambu-gray',
    border: 'border-bambu-dark-tertiary',
    divider: 'border-bambu-dark-tertiary',
    imageBox: 'border-bambu-dark-tertiary bg-bambu-dark',
    footer: 'border-bambu-dark-tertiary bg-bambu-dark-secondary text-bambu-gray-light',
    ringInner: 'bg-bambu-dark',
    logoPath: mode === 'light' ? '/img/printbuddy_logo_light.png' : '/img/printbuddy_logo_dark.png',
  };
}


function normalizeRefreshSeconds(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_REFRESH_SECONDS;
  return Math.min(300, Math.max(5, Math.round(value!)));
}

function normalizeState(status?: PrinterStatus): NormalizedState {
  const classified = classifyPrinterStatus(status, (status?.hms_errors?.length ?? 0) > 0);
  return classified === 'finished' ? 'idle' : classified;
}

function formatClock(date = new Date()): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatHeaderTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatHeaderDate(date: Date): string {
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatEta(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes) || minutes <= 0) return '—';
  const eta = new Date(Date.now() + minutes * 60_000);
  return eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function projectProgress(project: ProjectListItem): number | null {
  if (project.progress_percent !== null && project.progress_percent !== undefined) {
    return Math.min(100, Math.max(0, Math.round(project.progress_percent)));
  }
  if (project.target_parts_count && project.target_parts_count > 0) {
    return Math.min(100, Math.round((project.completed_count / project.target_parts_count) * 100));
  }
  if (project.target_count && project.target_count > 0) {
    return Math.min(100, Math.round((project.archive_count / project.target_count) * 100));
  }
  return null;
}

function projectTargetSummary(project: ProjectListItem): string {
  if (project.target_parts_count) {
    return `${project.completed_count} / ${project.target_parts_count} parts`;
  }
  if (project.target_count) {
    return `${project.archive_count} / ${project.target_count} plates`;
  }
  return `${project.archive_count} plates · ${project.completed_count} parts`;
}

function getJobName(item: MonitorPrinter): string | null {
  return item.status?.current_print || item.status?.subtask_name || item.status?.gcode_file || null;
}

function spoolLabel(spool: InventorySpool): string {
  return formatFilamentDescription(spool);
}

function spoolRemainingPct(spool: InventorySpool): number | null {
  if (!spool.label_weight || spool.label_weight <= 0) return null;
  const remaining = Math.max(0, spool.label_weight - (spool.weight_used ?? 0));
  return Math.round((remaining / spool.label_weight) * 100);
}

function normalizeSpoolColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const trimmed = color.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#') || trimmed.startsWith('rgb') || trimmed.startsWith('hsl')) return trimmed;
  if (/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(trimmed)) return `#${trimmed.slice(0, 6)}`;
  return trimmed;
}

function displaySpoolColor(color: string | null | undefined): string | null {
  const normalized = normalizeSpoolColor(color);
  return normalized?.startsWith('#') ? normalized.toUpperCase() : normalized;
}

function getLowSpoolAlerts(spools: InventorySpool[], defaultThreshold: number): MonitorAlert[] {
  return spools
    .filter((spool) => !spool.archived_at)
    .map((spool) => {
      const remainingPct = spoolRemainingPct(spool);
      const threshold = spool.low_stock_threshold_pct ?? defaultThreshold;
      return { spool, remainingPct, threshold };
    })
    .filter((entry): entry is { spool: InventorySpool; remainingPct: number; threshold: number } => entry.remainingPct !== null && entry.remainingPct <= entry.threshold)
    .sort((a, b) => a.remainingPct - b.remainingPct)
    .slice(0, 4)
    .map(({ spool, remainingPct }) => ({
      icon: PackageOpen,
      title: 'LOW FILAMENT',
      detail: spoolLabel(spool),
      sub: spool.storage_location || spool.category || 'Inventory spool',
      meta: `${remainingPct}%`,
      tone: 'text-orange-400',
    }));
}

function getMaintenanceAlerts(overview: PrinterMaintenanceOverview[]): MonitorAlert[] {
  return overview
    .flatMap((printer) => printer.maintenance_items.map((item) => ({ printer, item })))
    .filter(({ item }) => item.enabled && (item.is_due || item.is_warning))
    .sort((a, b) => Number(b.item.is_due) - Number(a.item.is_due) || a.item.hours_until_due - b.item.hours_until_due)
    .slice(0, 4)
    .map(({ printer, item }) => ({
      icon: Wrench,
      title: item.is_due ? 'MAINTENANCE DUE' : 'MAINTENANCE SOON',
      detail: printer.printer_name,
      sub: item.maintenance_type_name,
      meta: formatMaintenanceMeta(item),
      tone: item.is_due ? 'text-yellow-800 dark:text-yellow-300' : 'text-amber-800 dark:text-amber-300',
    }));
}

function formatMaintenanceMeta(item: MaintenanceStatus): string {
  if (item.interval_type === 'days') {
    if (item.days_until_due === null || item.days_until_due === undefined) return item.is_due ? 'due' : 'soon';
    if (item.days_until_due <= 0) return 'due';
    return `${Math.round(item.days_until_due)}d`;
  }
  if (item.hours_until_due <= 0) return 'due';
  return `${Math.round(item.hours_until_due)}h`;
}

function getPrinterAlerts(items: MonitorPrinter[]): MonitorAlert[] {
  return items.flatMap((item) => {
    const state = normalizeState(item.status);
    if (state === 'offline') {
      return [{
        icon: Power,
        title: 'PRINTER OFFLINE',
        detail: item.printer.name,
        sub: 'Connection lost',
        meta: 'now',
        tone: 'text-bambu-gray-light',
      }];
    }
    if (state === 'paused') {
      return [{
        icon: PauseCircle,
        title: 'PRINT PAUSED',
        detail: item.printer.name,
        sub: getJobName(item) || 'Paused by printer state',
        meta: formatDuration(item.status?.remaining_time),
        tone: 'text-amber-800 dark:text-amber-300',
      }];
    }
    if (state === 'stopped') {
      return [{
        icon: CirclePause,
        title: 'PRINT STOPPED',
        detail: item.printer.name,
        sub: getJobName(item) || 'Stopped by printer state',
        meta: 'stopped',
        tone: 'text-orange-800 dark:text-orange-300',
      }];
    }
    if (state === 'error' || (item.status?.hms_errors?.length ?? 0) > 0) {
      return [{
        icon: AlertTriangle,
        title: 'PRINTER ERROR',
        detail: item.printer.name,
        sub: `${item.status?.hms_errors?.length ?? 0} active printer error${(item.status?.hms_errors?.length ?? 0) === 1 ? '' : 's'}`,
        meta: 'error',
        tone: 'text-red-300',
      }];
    }
    return [];
  });
}

function StatTile({ icon: Icon, label, value, theme, tone = 'blue', suffix }: { icon: typeof PrinterIcon; label: string; value: string | number; theme: MonitorThemeClasses; tone?: 'blue' | 'green' | 'gray' | 'purple' | 'amber'; suffix?: string }) {
  const toneClasses = {
    blue: 'bg-bambu-green/15 text-bambu-green-light',
    green: 'bg-status-ok/15 text-status-ok',
    gray: 'bg-bambu-dark-tertiary text-bambu-gray-light',
    purple: 'bg-bambu-green/15 text-bambu-green-light',
    amber: 'bg-amber-500/15 text-amber-300',
  };

  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${theme.panel}`}>
      <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${toneClasses[tone]}`}>
        <Icon className="h-6 w-6" />
      </div>
      <div className="min-w-0">
        <div className={`text-[0.65rem] font-semibold uppercase tracking-wide ${theme.muted}`}>{label}</div>
        <div className={`flex items-baseline gap-1 text-2xl font-bold ${theme.text}`}>
          {value}{suffix && <span className={`text-sm font-semibold ${theme.muted}`}>{suffix}</span>}
        </div>
      </div>
    </div>
  );
}

function PrinterCard({ item, loadedFilament, theme }: { item: MonitorPrinter; loadedFilament: ResolvedLoadedFilamentInfo | null; theme: MonitorThemeClasses }) {
  const { printer, status } = item;
  const state = normalizeState(status);
  const progress = status?.progress === null || status?.progress === undefined ? null : Math.min(100, Math.max(0, Math.round(status.progress)));
  const nozzle = status?.temperatures?.nozzle === null || status?.temperatures?.nozzle === undefined ? null : Math.round(status.temperatures.nozzle);
  const bed = status?.temperatures?.bed === null || status?.temperatures?.bed === undefined ? null : Math.round(status.temperatures.bed);
  const layer = status?.layer_num ?? null;
  const totalLayers = status?.total_layers ?? null;
  const jobName = getJobName(item);

  const stateClasses = {
    printing: 'bg-status-ok/15 text-status-ok shadow-status-ok/20',
    idle: 'bg-bambu-green/15 text-bambu-green-light shadow-bambu-green/20',
    paused: 'bg-amber-500/15 text-amber-300 shadow-amber-500/20',
    stopped: 'bg-orange-500/15 text-orange-300 shadow-orange-500/20',
    offline: 'bg-bambu-dark-tertiary text-bambu-gray-light shadow-bambu-dark-tertiary',
    error: 'bg-red-500/15 text-red-300 shadow-red-500/20',
  };
  const stateLabel = state === 'printing' ? 'PRINTING' : state === 'paused' ? 'PAUSED' : state === 'stopped' ? 'STOPPED' : state === 'offline' ? 'OFFLINE' : state === 'error' ? 'ERROR' : 'IDLE';

  return (
    <article className={`min-w-0 rounded-2xl border p-4 sm:p-5 ${theme.card}`}>
      <div className="flex min-w-0 gap-3 sm:gap-4">
        <div className={`flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border p-2 sm:h-28 sm:w-32 ${theme.imageBox}`}>
          {state === 'offline' ? <TriangleAlert className="h-12 w-12 text-red-400" /> : <img src={getPrinterImage(printer.model)} alt="" className="max-h-full max-w-full object-contain" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`mb-3 inline-flex items-center gap-2 rounded-lg px-3 py-1 text-xs font-bold shadow-lg ${stateClasses[state]}`}>
            <span className={`h-2 w-2 rounded-full ${state === 'printing' ? 'bg-emerald-400' : state === 'paused' ? 'bg-amber-400' : state === 'stopped' ? 'bg-orange-400' : state === 'offline' ? 'bg-bambu-gray-light' : state === 'error' ? 'bg-red-400' : 'bg-bambu-green'}`} />
            {stateLabel}
          </div>
          <h2 className={`truncate text-lg font-bold ${theme.text}`}>{printer.name}</h2>
          <p className={`truncate text-sm ${theme.muted}`}>{printer.model || printer.provider || 'Printer'}</p>
          {printer.location && <p className={`truncate text-sm ${theme.muted}`}>{printer.location}</p>}
        </div>
      </div>

      {state === 'printing' ? (
        <div className="mt-5 space-y-3">
          <div>
            <div className={`mb-1 text-[0.68rem] font-semibold uppercase ${theme.subtle}`}>Current job</div>
            <div className="flex min-w-0 items-end justify-between gap-3">
              <div className={`truncate font-semibold ${theme.text}`}>{jobName ?? 'Active print'}</div>
              <div className={`text-2xl font-bold ${theme.text}`}>{progress !== null ? `${progress}%` : '—'}</div>
            </div>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-bambu-dark-tertiary">
            <div className="h-full rounded-full bg-gradient-to-r from-bambu-green-light to-bambu-green shadow-[0_0_14px_color-mix(in_srgb,var(--accent)_45%,transparent)]" style={{ width: `${progress ?? 0}%` }} />
          </div>
          <div className={`grid grid-cols-1 gap-2 text-sm min-[420px]:grid-cols-2 ${theme.muted}`}>
            <div className="flex min-w-0 items-center gap-2"><Clock3 className={`h-4 w-4 shrink-0 ${theme.muted}`} /> ETA <span className="font-semibold text-bambu-green-light">{formatEta(status?.remaining_time)}</span></div>
            <div className="flex min-w-0 items-center gap-2 min-[420px]:justify-end"><Bell className={`h-4 w-4 shrink-0 ${theme.muted}`} /> {formatDuration(status?.remaining_time)}</div>
            {(layer !== null || totalLayers !== null) && <div className="flex min-w-0 items-center gap-2 min-[420px]:col-span-2"><Layers className={`h-4 w-4 shrink-0 ${theme.muted}`} /> {layer ?? '—'} / {totalLayers ?? '—'} layers</div>}
          </div>
        </div>
      ) : (
        <div className={`mt-7 min-h-[5.6rem] border-b pb-5 ${theme.divider}`}>
          <div className={`text-xl font-bold ${state === 'paused' ? 'text-amber-400' : state === 'stopped' ? 'text-orange-400' : state === 'offline' || state === 'error' ? 'text-red-400' : theme.text}`}>{stateLabel}</div>
          <p className={`mt-1 text-sm ${theme.muted}`}>{state === 'paused' ? 'Print paused' : state === 'stopped' ? 'Print stopped' : state === 'offline' ? 'No connection' : state === 'error' ? 'Needs attention' : 'Ready to print'}</p>
        </div>
      )}

      {(nozzle !== null || bed !== null) && (
        <div className={`mt-4 grid grid-cols-2 overflow-hidden rounded-xl border ${theme.divider} ${theme.panelSoft}`}>
          <div className={`flex min-w-0 items-center gap-3 border-r px-3 py-3 sm:px-4 ${theme.divider}`}>
            <Thermometer className="h-6 w-6 shrink-0 text-red-400" />
            <div><div className={`font-bold ${theme.text}`}>{nozzle !== null ? `${nozzle}°C` : '—'}</div><div className={`text-xs ${theme.muted}`}>Nozzle</div></div>
          </div>
          <div className="flex min-w-0 items-center justify-end gap-3 px-3 py-3 sm:px-4">
            <Thermometer className="h-6 w-6 text-blue-400" />
            <div><div className={`font-bold ${theme.text}`}>{bed !== null ? `${bed}°C` : '—'}</div><div className={`text-xs ${theme.muted}`}>Bed</div></div>
          </div>
        </div>
      )}

      {loadedFilament && (
        <div className={`mt-2 grid grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-xl border ${theme.divider} ${theme.panelSoft}`}>
          <div className="flex min-w-0 items-center gap-3 px-3 py-3 sm:px-4">
            <span className={`h-9 w-9 rounded-xl border ${theme.divider} shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25)]`} style={{ backgroundColor: normalizeSpoolColor(loadedFilament.color) || 'var(--bg-tertiary)' }} />
            <div className="min-w-0">
              <div className={`truncate text-sm font-medium ${theme.text}`}>{loadedFilament.material}</div>
              <div className={`truncate text-xs ${theme.muted}`}>{loadedFilament.detail}{displaySpoolColor(loadedFilament.color) ? ` · ${displaySpoolColor(loadedFilament.color)}` : ''}</div>
            </div>
          </div>
          {loadedFilament.remainingPct !== null && loadedFilament.remainingPct !== undefined && (
            <div className={`flex min-w-16 items-center justify-center border-l px-3 py-3 text-center text-xs font-bold sm:min-w-24 sm:px-4 ${theme.divider} ${theme.muted}`}>
              {loadedFilament.remainingPct}%<br />LEFT
            </div>
          )}
        </div>
      )}
    </article>
  );
}

interface CompactFilament {
  slot: string;
  name: string;
  color: string | null;
  remainingGrams: number | null;
  remainingPct: number | null;
  spoolId: number | null;
  active: boolean;
  manufacturer: string | null;
  material: string | null;
  filamentName: string | null;
  colorName: string | null;
}

function getCompactFilaments(item: MonitorPrinter, loadedFilament: ResolvedLoadedFilamentInfo | null, localAssignments: SpoolAssignment[], spoolmanAssignments: SpoolmanSlotAssignmentLike[], spoolmanSpools: InventorySpool[]): CompactFilament[] {
  const slots = (item.status?.ams ?? []).flatMap((unit) => (unit.tray ?? []).map((tray) => ({ unit, tray })));
  const filaments = slots.flatMap(({ unit, tray }) => {
    const assignedId = spoolmanAssignments.find((assignment) => assignment.printer_id === item.printer.id && assignment.ams_id === unit.id && assignment.tray_id === tray.id)?.spoolman_spool_id ?? tray.spoolman_spool_id;
    const spool = spoolmanSpools.find((candidate) => candidate.id === assignedId)
      ?? localAssignments.find((assignment) => assignment.printer_id === item.printer.id && assignment.ams_id === unit.id && assignment.tray_id === tray.id)?.spool;
    if (!spool && !tray.tray_type && !tray.spoolman_filament_name) return [];
    const remainingGrams = spool ? Math.max(0, spool.label_weight - spool.weight_used) : tray.remaining_weight ?? null;
    const initialGrams = spool?.label_weight ?? tray.initial_weight;
    return [{
      slot: `${unit.name || (unit.id === 0 ? 'Slots' : `Unit ${unit.id}`)} · ${tray.id + 1}`,
      name: spool ? spoolLabel(spool) : [tray.spoolman_vendor, tray.spoolman_filament_name || tray.tray_type].filter(Boolean).join(' '),
      color: spool?.rgba ?? tray.tray_color,
      remainingGrams,
      remainingPct: initialGrams && initialGrams > 0 && remainingGrams !== null ? Math.round(remainingGrams / initialGrams * 100) : tray.remain >= 0 ? tray.remain : null,
      spoolId: spool?.id ?? assignedId ?? null,
      active: item.status?.connected === true && (tray.active === true || item.status.tray_now === getGlobalTrayId(unit.id, tray.id, false)),
      manufacturer: spool?.brand ?? tray.spoolman_vendor ?? null,
      material: spool?.material ?? tray.tray_type,
      filamentName: spool?.subtype ?? tray.spoolman_filament_name ?? tray.tray_sub_brands ?? null,
      colorName: spool?.color_name ?? null,
    }];
  });
  for (const tray of item.status?.vt_tray ?? []) {
    if (!tray.tray_type && !tray.spoolman_filament_name) continue;
    const assignedId = spoolmanAssignments.find((assignment) => assignment.printer_id === item.printer.id && assignment.ams_id === 255 && assignment.tray_id === tray.id - 254)?.spoolman_spool_id ?? tray.spoolman_spool_id;
    const spool = spoolmanSpools.find((candidate) => candidate.id === assignedId) ?? localAssignments.find((assignment) => assignment.printer_id === item.printer.id && assignment.ams_id === 255 && assignment.tray_id === tray.id - 254)?.spool;
    const remainingGrams = spool ? Math.max(0, spool.label_weight - spool.weight_used) : tray.remaining_weight ?? null;
    const initialGrams = spool?.label_weight ?? tray.initial_weight;
    filaments.push({ slot: 'External spool', name: spool ? spoolLabel(spool) : [tray.spoolman_vendor, tray.spoolman_filament_name || tray.tray_type].filter(Boolean).join(' '), color: spool?.rgba ?? tray.tray_color, remainingGrams, remainingPct: initialGrams && initialGrams > 0 && remainingGrams !== null ? Math.round(remainingGrams / initialGrams * 100) : tray.remain >= 0 ? tray.remain : null, spoolId: spool?.id ?? assignedId ?? null, active: item.status?.connected === true && item.status.tray_now === tray.id, manufacturer: spool?.brand ?? tray.spoolman_vendor ?? null, material: spool?.material ?? tray.tray_type, filamentName: spool?.subtype ?? tray.spoolman_filament_name ?? tray.tray_sub_brands ?? null, colorName: spool?.color_name ?? null });
  }
  if (filaments.length || !loadedFilament) return filaments;
  return [{ slot: loadedFilament.detail, name: loadedFilament.material, color: loadedFilament.color ?? null, remainingGrams: loadedFilament.spool ? Math.max(0, loadedFilament.spool.label_weight - loadedFilament.spool.weight_used) : null, remainingPct: loadedFilament.remainingPct ?? null, spoolId: loadedFilament.spool?.id ?? null, active: item.status?.connected === true && (loadedFilament.globalTrayId === item.status.tray_now || loadedFilament.tray?.active === true), manufacturer: loadedFilament.spool?.brand ?? null, material: loadedFilament.spool?.material ?? loadedFilament.tray?.tray_type ?? null, filamentName: loadedFilament.spool?.subtype ?? loadedFilament.tray?.spoolman_filament_name ?? null, colorName: loadedFilament.spool?.color_name ?? null }];
}

function CompactPrinterCard({ item, loadedFilament, onOpen, theme }: { item: MonitorPrinter; loadedFilament: ResolvedLoadedFilamentInfo | null; onOpen: () => void; theme: MonitorThemeClasses }) {
  const { printer, status } = item;
  const state = normalizeState(status);
  const progress = status?.progress == null ? null : Math.min(100, Math.max(0, Math.round(status.progress)));
  const nozzle = status?.temperatures?.nozzle;
  const bed = status?.temperatures?.bed;
  const warnings = status?.hms_errors?.length ?? 0;
  const stateClasses = state === 'printing' ? 'bg-status-ok/15 text-status-ok' : state === 'idle' ? 'bg-bambu-green/15 text-bambu-green-light' : state === 'paused' ? 'bg-amber-500/15 text-amber-300' : state === 'offline' ? 'bg-bambu-dark-tertiary text-bambu-gray-light' : state === 'error' ? 'bg-red-500/15 text-red-300' : 'bg-orange-500/15 text-orange-300';
  const activeFilament = (state === 'printing' || state === 'paused') && loadedFilament && (loadedFilament.globalTrayId === status?.tray_now || loadedFilament.tray?.active === true) ? loadedFilament : null;

  return (
    <article className={`h-full min-w-0 overflow-hidden rounded-xl border p-2 ${theme.card}`} aria-label={`${printer.name} printer`}>
      <button type="button" onClick={onOpen} aria-label={`Details for ${printer.name}`} className="flex h-full w-full min-w-0 flex-col justify-start rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bambu-green">
        <div className="flex w-full min-w-0 gap-2">
          <div className={`flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border p-1 ${theme.imageBox}`}>
            <img src={getPrinterImage(printer.model)} alt="" className={`max-h-full max-w-full object-contain ${state === 'offline' ? 'opacity-50' : ''}`} />
          </div>
          <div className="min-w-0 flex-1">
            <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[0.68rem] font-bold ${stateClasses}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{state.toUpperCase()}</span>
            <h2 className={`mt-1 truncate text-sm font-bold ${theme.text}`}>{printer.name}</h2>
            <p className={`truncate text-xs ${theme.muted}`}>{printer.model || printer.provider || 'Printer'}</p>
          </div>
        </div>
        {state === 'printing' || state === 'paused' ? <div className="mt-1.5 w-full min-w-0">
          <div className={`flex min-w-0 justify-between gap-2 text-xs font-semibold ${theme.text}`}><span className="truncate">{getJobName(item) || 'Active print'}</span><span className="shrink-0">{progress === null ? '—' : `${progress}%`}</span></div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-bambu-dark-tertiary"><div className="h-full rounded-full bg-gradient-to-r from-bambu-green-light to-bambu-green" style={{ width: `${progress ?? 0}%` }} /></div>
          <div className={`mt-1 flex items-center justify-between gap-1 text-xs ${theme.muted}`}><span className="flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />ETA {formatEta(status?.remaining_time)}</span><span>{formatDuration(status?.remaining_time)} left</span></div>
        </div> : <div className={`mt-1.5 w-full truncate text-sm font-semibold ${theme.text}`}>{state === 'offline' ? 'No connection' : state === 'error' ? 'Needs attention' : state === 'idle' ? 'Ready to print' : state === 'stopped' ? 'Print stopped' : 'Print paused'}</div>}
        <div className={`mt-1.5 grid w-full grid-cols-2 overflow-hidden rounded-lg border ${theme.divider} ${theme.panelSoft}`}>
          <div className={`flex items-center gap-1.5 border-r px-2 py-1 ${theme.divider}`}><Thermometer className="h-4 w-4 shrink-0 text-red-400" /><span className={`text-xs font-bold ${theme.text}`}>{nozzle == null ? '—' : `${Math.round(nozzle)}°C`}</span><span className={`text-[0.65rem] ${theme.muted}`}>Nozzle</span></div>
          <div className="flex items-center justify-end gap-1.5 px-2 py-1"><Thermometer className="h-4 w-4 shrink-0 text-blue-400" /><span className={`text-xs font-bold ${theme.text}`}>{bed == null ? '—' : `${Math.round(bed)}°C`}</span><span className={`text-[0.65rem] ${theme.muted}`}>Bed</span></div>
        </div>
        {(state === 'printing' || state === 'paused') && <div className={`mt-1 flex w-full min-w-0 items-center gap-2 rounded-lg border px-2 py-1 ${theme.divider} ${theme.panelSoft}`}>
          <span className={`h-7 w-7 shrink-0 rounded-lg border ${theme.divider}`} style={{ backgroundColor: activeFilament ? normalizeSpoolColor(activeFilament.color) || 'var(--bg-tertiary)' : 'var(--bg-tertiary)' }} />
          <div className="min-w-0 flex-1"><div className={`truncate text-xs font-medium ${theme.text}`}>{activeFilament?.material || 'Filament unavailable'}</div>{activeFilament && <div className={`truncate text-[0.65rem] ${theme.muted}`}>{activeFilament.detail}</div>}</div>
          <span className={`shrink-0 text-xs font-bold ${theme.muted}`}>{activeFilament?.remainingPct == null ? '—' : `${activeFilament.remainingPct}%`}</span>
        </div>}
        {(warnings > 0 || state === 'error' || state === 'offline') && <div className="mt-1 flex w-full min-w-0 items-center gap-1 text-xs font-semibold text-amber-300"><AlertTriangle className="h-4 w-4 shrink-0" /><span className="truncate">{warnings > 0 ? `${warnings} printer alert${warnings === 1 ? '' : 's'}` : state === 'offline' ? 'Printer offline' : 'Printer needs attention'}</span></div>}
      </button>
    </article>
  );
}

function CompactPrinterDetail({ item, filaments, theme, onClose }: { item: MonitorPrinter; filaments: CompactFilament[]; theme: MonitorThemeClasses; onClose: () => void }) {
  const { printer, status } = item;
  const state = normalizeState(status);
  const activePrint = state === 'printing' || state === 'paused';
  const progress = status?.progress == null ? null : Math.min(100, Math.max(0, Math.round(status.progress)));
  const temperatures = status?.temperatures;
  const temperatureRows = [
    { label: 'Nozzle', current: temperatures?.nozzle, target: temperatures?.nozzle_target, color: 'text-red-400' },
    { label: 'Bed', current: temperatures?.bed, target: temperatures?.bed_target, color: 'text-blue-400' },
    { label: 'Chamber', current: temperatures?.chamber, target: temperatures?.chamber_target, color: 'text-amber-400' },
  ].filter((row) => row.current != null || row.target != null);
  const warnings = status?.hms_errors ?? [];
  const extraStatus = [
    status?.wired_network ? 'Ethernet connected' : status?.wifi_signal != null ? `Wi-Fi ${status.wifi_signal} dBm` : null,
    status?.door_open ? 'Door open' : null,
    status?.timelapse ? 'Timelapse active' : null,
    status?.firmware_version ? `Firmware ${status.firmware_version}` : null,
  ].filter((detail): detail is string => Boolean(detail));
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2" role="presentation" onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-label={`${printer.name} details`} className={`max-h-[95vh] w-full max-w-3xl overflow-y-auto rounded-xl border ${theme.page}`} onClick={(event) => event.stopPropagation()}>
      <div className={`sticky top-0 z-10 flex items-center gap-3 border-b p-3 ${theme.page} ${theme.divider}`}><img src={getPrinterImage(printer.model)} alt="" className="h-14 w-14 shrink-0 object-contain" /><div className="min-w-0 flex-1"><h2 className={`truncate text-lg font-bold ${theme.text}`}>{printer.name}</h2><p className={`text-sm ${theme.muted}`}>{printer.model || printer.provider} · {state.toUpperCase()} · {status?.connected === true ? 'Connected' : status?.connected === false ? 'Disconnected' : 'Connection unknown'}</p></div><button type="button" autoFocus onClick={onClose} className={`min-h-11 rounded-lg border px-4 ${theme.panelSoft}`}>Close</button></div>
      <div className="space-y-3 p-3">
        {(warnings.length > 0 || status?.door_open || status?.connected === false) && <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2" aria-label="Printer warnings"><h3 className="flex items-center gap-2 text-sm font-bold text-amber-300"><AlertTriangle className="h-4 w-4" />Warnings</h3><div className="mt-1 flex flex-wrap gap-2 text-xs text-amber-200">{status?.connected === false && <span>Printer disconnected</span>}{status?.door_open && <span>Door open</span>}{warnings.map((warning, index) => <span key={`${warning.code}-${index}`}>Printer alert {warning.code} · severity {warning.severity}</span>)}</div></section>}
        {activePrint && <section className={`rounded-lg border p-3 ${theme.panelSoft}`} aria-label="Current print"><h3 className={`mb-1 flex items-center gap-2 text-xs font-bold uppercase ${theme.muted}`}><PrinterIcon className="h-4 w-4" />Current print</h3><div className={`break-words text-sm font-semibold [overflow-wrap:anywhere] ${theme.text}`}>{getJobName(item) || 'Active print'}</div><div className="mt-2 flex items-center justify-between text-sm"><span className={theme.muted}>Progress</span><strong>{progress === null ? '—' : `${progress}%`}</strong></div><div className="mt-1 h-2 overflow-hidden rounded-full bg-bambu-dark-tertiary"><div className="h-full rounded-full bg-gradient-to-r from-bambu-green-light to-bambu-green" style={{ width: `${progress ?? 0}%` }} /></div><div className={`mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs ${theme.muted}`}><span className="flex items-center gap-1"><Clock3 className="h-4 w-4" />ETA {formatEta(status?.remaining_time)}</span><span>{formatDuration(status?.remaining_time)} remaining</span>{(status?.layer_num != null || status?.total_layers != null) && <span className="flex items-center gap-1"><Layers className="h-4 w-4" />Layer {status?.layer_num ?? '—'} / {status?.total_layers ?? '—'}</span>}</div></section>}
        {temperatureRows.length > 0 && <section aria-label="Temperatures"><h3 className={`mb-2 flex items-center gap-2 text-sm font-bold ${theme.text}`}><Thermometer className="h-4 w-4" />Temperatures</h3><div className="grid grid-cols-1 gap-2 sm:grid-cols-3">{temperatureRows.map((row) => <div key={row.label} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${theme.panelSoft}`}><Thermometer className={`h-5 w-5 ${row.color}`} /><div><div className={`text-xs ${theme.muted}`}>{row.label}</div><div className={`text-sm font-bold ${theme.text}`}>{row.current == null ? '—' : `${Math.round(row.current)}°C`}{row.target != null && <span className={`ml-1 text-xs font-normal ${theme.muted}`}>/ {Math.round(row.target)}°C target</span>}</div></div></div>)}</div></section>}
        {filaments.length > 0 && <section aria-label="Loaded filament slots"><h3 className={`mb-2 flex items-center gap-2 text-sm font-bold ${theme.text}`}><PackageOpen className="h-4 w-4" />Loaded filament slots · {filaments.length}</h3><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{filaments.map((filament, index) => <div key={`${filament.slot}-${index}`} className={`flex min-w-0 items-center gap-2 rounded-lg border p-2 ${theme.panelSoft}`}><span className={`h-10 w-10 shrink-0 rounded-lg border ${theme.divider}`} style={{ backgroundColor: normalizeSpoolColor(filament.color) || 'var(--bg-tertiary)' }} /><div className="min-w-0 flex-1"><div className={`flex flex-wrap items-center gap-1 text-xs font-semibold ${theme.text}`}>{filament.slot}{filament.active && <span className="rounded bg-bambu-green/20 px-1.5 py-0.5 text-[0.65rem] text-bambu-green-light">ACTIVE</span>}</div><div className={`break-words text-xs [overflow-wrap:anywhere] ${theme.text}`}>{filament.name}</div>{filament.spoolId != null && <div className={`text-[0.65rem] ${theme.muted}`}>Spool #{filament.spoolId}</div>}</div><div className={`shrink-0 text-right text-xs font-bold ${theme.text}`}>{filament.remainingGrams === null ? '—' : `${Math.round(filament.remainingGrams)} g`}<div className={theme.muted}>{filament.remainingPct === null ? '—' : `${filament.remainingPct}%`}</div></div></div>)}</div></section>}
        {extraStatus.length > 0 && <section aria-label="Additional status"><h3 className={`mb-2 flex items-center gap-2 text-sm font-bold ${theme.text}`}><Server className="h-4 w-4" />Additional status</h3><div className={`flex flex-wrap gap-2 text-xs ${theme.muted}`}>{extraStatus.map((detail) => <span key={detail} className={`rounded-lg border px-2 py-1.5 ${theme.panelSoft}`}>{detail}</span>)}</div></section>}
      </div>
    </div>
  </div>;
}

function AlertsPanel({ alerts, theme }: { alerts: MonitorAlert[]; theme: MonitorThemeClasses }) {
  return (
    <section className={`min-w-0 overflow-hidden rounded-2xl border p-5 ${theme.card}`}>
      <div className={`mb-4 flex items-center justify-between border-b pb-4 ${theme.divider}`}>
        <div className={`flex items-center gap-3 text-xl font-bold ${theme.text}`}><Bell className="h-6 w-6 text-orange-400" /> ALERTS</div>
        <span className={`text-sm ${theme.muted}`}>{alerts.length} active</span>
      </div>
      {alerts.length > 0 ? (
        <div className={`divide-y ${theme.divider}`}>
          {alerts.slice(0, 5).map((alert) => (
            <div key={`${alert.title}-${alert.detail}-${alert.sub}`} className="flex min-w-0 gap-4 py-4 first:pt-0 last:pb-0">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15"><alert.icon className={`h-5 w-5 ${alert.tone}`} /></div>
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-bold ${alert.tone}`}>{alert.title}</div>
                <div className={`truncate text-sm ${theme.text}`}>{alert.detail}</div>
                <div className={`truncate text-sm ${theme.muted}`}>{alert.sub}</div>
              </div>
              <div className={`shrink-0 text-right text-lg font-bold ${theme.text}`}>{alert.meta}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className={`py-8 text-center text-sm ${theme.muted}`}>No active alerts from printer, inventory, or maintenance data.</div>
      )}
    </section>
  );
}

function ActivityPanel({ items, theme }: { items: MonitorPrinter[]; theme: MonitorThemeClasses }) {
  const activity = items
    .filter((item) => ['printing', 'paused', 'stopped', 'offline', 'error'].includes(normalizeState(item.status)))
    .slice(0, 4)
    .map((item) => {
      const state = normalizeState(item.status);
      return {
        name: item.printer.name,
        detail: state === 'printing' ? 'Printing' : state === 'paused' ? 'Print paused' : state === 'stopped' ? 'Print stopped' : state === 'offline' ? 'Connection lost' : 'Printer error',
        state,
      };
    });

  return (
    <section className={`min-w-0 overflow-hidden rounded-2xl border p-5 ${theme.card}`}>
      <h2 className={`mb-4 text-base font-semibold uppercase tracking-wide ${theme.muted}`}>Recent Activity</h2>
      {activity.length > 0 ? (
        <div className="space-y-4">
          {activity.map((entry) => (
            <div key={`${entry.name}-${entry.detail}`} className="flex min-w-0 gap-3">
              <div className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-full ${entry.state === 'paused' || entry.state === 'stopped' ? 'text-amber-400' : entry.state === 'offline' ? 'text-bambu-gray-light' : entry.state === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>
                {entry.state === 'paused' || entry.state === 'stopped' ? <CirclePause className="h-5 w-5" /> : entry.state === 'offline' ? <Power className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className={`truncate text-sm font-medium ${theme.text}`}>{entry.name}</div>
                <div className={`truncate text-sm ${theme.muted}`}>{entry.detail}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={`py-8 text-center text-sm ${theme.muted}`}>No active printer events.</div>
      )}
    </section>
  );
}

function ActiveProjectsPanel({ projects, theme }: { projects: ProjectListItem[]; theme: MonitorThemeClasses }) {
  const visibleProjects = projects
    .slice()
    .sort((a, b) => (projectProgress(b) ?? -1) - (projectProgress(a) ?? -1))
    .slice(0, 3);

  return (
    <section className={`min-w-0 overflow-hidden rounded-2xl border p-5 ${theme.card}`}>
      <div className={`mb-4 flex min-w-0 items-center justify-between gap-3 border-b pb-4 ${theme.divider}`}>
        <div className={`flex min-w-0 items-center gap-3 text-xl font-bold ${theme.text}`}><PackageOpen className="h-6 w-6 shrink-0 text-bambu-green-light" /> <span className="truncate">ACTIVE PROJECTS</span></div>
        <span className={`text-sm ${theme.muted}`}>{projects.length} active</span>
      </div>
      {visibleProjects.length > 0 ? (
        <div className="space-y-4">
          {visibleProjects.map((project) => {
            const progress = projectProgress(project);
            return (
              <article key={project.id} className={`min-w-0 overflow-hidden rounded-xl border p-4 ${theme.panelSoft}`}>
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: project.color || 'var(--accent)' }} />
                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-base font-bold ${theme.text}`}>{project.name}</div>
                    {project.description && <div className={`truncate text-sm ${theme.muted}`}>{project.description}</div>}
                  </div>
                  <div className={`shrink-0 text-right text-lg font-bold ${theme.text}`}>{progress !== null ? `${progress}%` : '—'}</div>
                </div>
                <div className="mt-4 h-2 min-w-0 overflow-hidden rounded-full bg-bambu-dark-tertiary">
                  <div className="h-full rounded-full bg-gradient-to-r from-bambu-green-light to-bambu-green" style={{ width: `${progress ?? 0}%` }} />
                </div>
                <div className={`mt-3 flex min-w-0 flex-wrap items-center gap-3 text-xs font-semibold uppercase tracking-wide ${theme.muted}`}>
                  <span>{projectTargetSummary(project)}</span>
                  {project.queue_count > 0 && <span>{project.queue_count} queued</span>}
                  {project.failed_count > 0 && <span className="text-red-300">{project.failed_count} failed</span>}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className={`py-8 text-center text-sm ${theme.muted}`}>No active projects are currently tracked.</div>
      )}
    </section>
  );
}

export function PrintFarmMonitorPage() {
  const [now, setNow] = useState(() => new Date());
  const compact = useCompactViewport();
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const [printerPage, setPrinterPage] = useState(0);
  const [secondaryPanel, setSecondaryPanel] = useState<'alerts' | 'projects' | 'activity' | null>(null);
  const [detailPrinterId, setDetailPrinterId] = useState<number | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const { mode } = useTheme();
  const theme = useMemo(() => getMonitorTheme(mode), [mode]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const update = () => { setViewportWidth(window.innerWidth); setViewportHeight(window.innerHeight); };
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (!secondaryPanel && detailPrinterId === null) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSecondaryPanel(null); setDetailPrinterId(null); } };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [secondaryPanel, detailPrinterId]);

  const { data: uiPreferences } = useQuery({ queryKey: ['ui-preferences'], queryFn: api.getUiPreferences, staleTime: 30_000 });
  const refreshSeconds = normalizeRefreshSeconds(uiPreferences?.print_farm_monitor_refresh_interval);
  const refreshMs = refreshSeconds * 1000;
  const { data: printers = [] } = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters, refetchInterval: refreshMs });
  const { data: queue = [] } = useQuery({ queryKey: ['queue', 'monitor'], queryFn: () => api.getQueue(), refetchInterval: refreshMs });
  const { data: activeProjects = [] } = useQuery({ queryKey: ['projects', 'active', 'monitor'], queryFn: () => api.getProjects('active'), refetchInterval: refreshMs, retry: false });
  const { data: version } = useQuery({ queryKey: ['version'], queryFn: api.getVersion, staleTime: Infinity });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const { data: spoolmanSettings } = useQuery({ queryKey: ['settings', 'spoolman', 'monitor'], queryFn: api.getSpoolmanSettings, staleTime: 60_000, retry: false });
  const { data: localAssignments = [] } = useQuery({ queryKey: ['inventory-assignments', 'monitor'], queryFn: () => api.getAssignments(), refetchInterval: refreshMs, retry: false });
  const { data: localSpools = [] } = useQuery({ queryKey: ['inventory-spools', 'monitor'], queryFn: () => api.getSpools(false), refetchInterval: refreshMs, retry: false });
  const spoolmanEnabled = spoolmanSettings?.spoolman_enabled === 'true';
  const { data: spoolmanSpools = [] } = useQuery({ queryKey: ['spoolman-inventory-spools', 'monitor'], queryFn: () => api.getSpoolmanInventorySpools(false), enabled: spoolmanEnabled, refetchInterval: refreshMs, retry: false });
  const { data: spoolmanSlotAssignments = [] } = useQuery({ queryKey: ['spoolman-slot-assignments', 'monitor'], queryFn: () => api.getSpoolmanSlotAssignments(), enabled: spoolmanEnabled, refetchInterval: refreshMs, retry: false });
  const { data: maintenanceOverview = [] } = useQuery({ queryKey: ['maintenance-overview', 'monitor'], queryFn: api.getMaintenanceOverview, refetchInterval: refreshMs, retry: false });
  const statusQueries = useQueries({
    queries: printers.map((printer) => ({
      queryKey: ['printerStatus', printer.id],
      queryFn: () => api.getPrinterStatus(printer.id),
      refetchInterval: refreshMs,
      enabled: printer.is_active !== false,
    })),
  });

  const monitorPrinters = useMemo<MonitorPrinter[]>(() => printers.map((printer, index) => ({ printer, status: statusQueries[index]?.data })), [printers, statusQueries]);
  const loadedFilaments = useMemo(() => new Map(monitorPrinters.map((item) => [item.printer.id, resolveLoadedFilamentInfo({
    printer: item.printer,
    status: item.status,
    localAssignments,
    spoolmanSpools,
    spoolmanSlotAssignments: spoolmanSlotAssignments as SpoolmanSlotAssignmentLike[],
  })])), [localAssignments, monitorPrinters, spoolmanSlotAssignments, spoolmanSpools]);
  const compactFilaments = useMemo(() => new Map(monitorPrinters.map((item) => [item.printer.id, getCompactFilaments(item, loadedFilaments.get(item.printer.id) ?? null, localAssignments, spoolmanSlotAssignments as SpoolmanSlotAssignmentLike[], spoolmanSpools)])), [loadedFilaments, localAssignments, monitorPrinters, spoolmanSlotAssignments, spoolmanSpools]);
  const printing = monitorPrinters.filter((item) => normalizeState(item.status) === 'printing');
  const paused = monitorPrinters.filter((item) => normalizeState(item.status) === 'paused');
  const stopped = monitorPrinters.filter((item) => normalizeState(item.status) === 'stopped');
  const offline = monitorPrinters.filter((item) => normalizeState(item.status) === 'offline');
  const idle = monitorPrinters.filter((item) => normalizeState(item.status) === 'idle');
  const errors = monitorPrinters.filter((item) => normalizeState(item.status) === 'error' || (item.status?.hms_errors?.length ?? 0) > 0);
  const utilization = printers.length > 0 ? Math.round((printing.length / printers.length) * 100) : 0;
  const activeAlerts = useMemo(() => [
    ...getPrinterAlerts(monitorPrinters),
    ...getLowSpoolAlerts(spoolmanEnabled ? spoolmanSpools : localSpools, settings?.low_stock_threshold ?? 20),
    ...getMaintenanceAlerts(maintenanceOverview),
  ], [localSpools, maintenanceOverview, monitorPrinters, settings?.low_stock_threshold, spoolmanEnabled, spoolmanSpools]);
  const nextCompletion = printing
    .filter((item) => item.status?.remaining_time !== null && item.status?.remaining_time !== undefined)
    .sort((a, b) => (a.status?.remaining_time ?? 99999) - (b.status?.remaining_time ?? 99999))[0];
  const visiblePrinters = monitorPrinters;
  const utilizationStyle = { background: `conic-gradient(var(--accent) ${utilization * 3.6}deg, var(--bg-tertiary) 0deg)` };
  const compactColumns = Math.max(1, Math.floor((viewportWidth - 8) / 288));
  const compactRows = Math.max(1, Math.floor((viewportHeight - 132) / 218));
  const compactPageSize = compactColumns * compactRows;
  const compactPageCount = Math.max(1, Math.ceil(monitorPrinters.length / compactPageSize));
  const currentPrinterPage = Math.min(printerPage, compactPageCount - 1);
  const compactPrinters = monitorPrinters.slice(currentPrinterPage * compactPageSize, (currentPrinterPage + 1) * compactPageSize);
  const detailPrinter = monitorPrinters.find((item) => item.printer.id === detailPrinterId);

  useEffect(() => { setPrinterPage((page) => Math.min(page, compactPageCount - 1)); }, [compactPageCount]);

  if (compact) {
    return (
      <main className={`flex h-screen min-h-0 flex-col overflow-hidden p-2 ${theme.page}`} data-monitor-theme={mode} data-testid="compact-farm-monitor">
        <header className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 ${theme.panelSoft}`}>
          <Link to="/farm-command-center" aria-label="Back to Farm Command Center" className={`flex h-11 w-11 items-center justify-center rounded-lg border ${theme.border}`}><ArrowLeft className="h-5 w-5" /></Link>
          <h1 className={`mr-auto text-base font-bold ${theme.text}`}>Farm Monitor</h1>
          <time className="font-mono text-base font-bold text-blue-300">{formatClock(now)}</time>
          <div className={`flex flex-wrap gap-x-3 text-sm ${theme.muted}`} aria-label="Printer counts"><span>{printing.length} printing</span><span>{idle.length} idle</span><span>{offline.length} offline</span></div>
          <button type="button" onClick={() => setScanOpen(true)} className="flex min-h-11 items-center gap-2 rounded-lg border border-blue-500/50 px-3 text-sm font-semibold text-blue-200"><ScanLine className="h-5 w-5" /> Scan Filament</button>
          <button type="button" onClick={() => setSecondaryPanel('alerts')} className="min-h-11 rounded-lg border border-amber-500/40 px-3 text-sm font-semibold text-amber-300">Alerts {activeAlerts.length}</button>
        </header>

        <section aria-label="Printers" className="mt-2 grid min-h-0 min-w-0 flex-1 gap-2" style={{ gridTemplateColumns: `repeat(${compactColumns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${compactRows}, minmax(0, 1fr))` }} data-testid="compact-printer-grid">
          {compactPrinters.map((item) => <CompactPrinterCard key={item.printer.id} item={item} loadedFilament={loadedFilaments.get(item.printer.id) ?? null} onOpen={() => setDetailPrinterId(item.printer.id)} theme={theme} />)}
          {monitorPrinters.length === 0 && <p className={`rounded-xl border p-4 ${theme.panelSoft}`}>No printers configured.</p>}
        </section>

        <nav aria-label="Printer pages" className="mt-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <button type="button" onClick={() => setSecondaryPanel('projects')} className={`min-h-11 rounded-lg border px-3 text-sm ${theme.panelSoft}`}>Projects {activeProjects.length}</button>
            <button type="button" onClick={() => setSecondaryPanel('activity')} className={`min-h-11 rounded-lg border px-3 text-sm ${theme.panelSoft}`}>Activity</button>
          </div>
          {compactPageCount > 1 && <div className="flex items-center gap-2">
            <button type="button" disabled={currentPrinterPage === 0} onClick={() => setPrinterPage(currentPrinterPage - 1)} className={`min-h-11 rounded-lg border px-3 text-sm disabled:opacity-40 ${theme.panelSoft}`}>Previous printers</button>
            <span className={`text-sm ${theme.muted}`}>Page {currentPrinterPage + 1} of {compactPageCount}</span>
            <button type="button" disabled={currentPrinterPage >= compactPageCount - 1} onClick={() => setPrinterPage(currentPrinterPage + 1)} className={`min-h-11 rounded-lg border px-3 text-sm disabled:opacity-40 ${theme.panelSoft}`}>Next printers</button>
          </div>}
        </nav>
        <p className={`mt-1 text-xs ${theme.muted}`}>Refreshes every {refreshSeconds}s · {version?.display_version ?? version?.version ? `v${version?.display_version ?? version?.version}` : 'PrintBuddy'}</p>

        {detailPrinter && <CompactPrinterDetail item={detailPrinter} filaments={compactFilaments.get(detailPrinter.printer.id) ?? []} theme={theme} onClose={() => setDetailPrinterId(null)} />}
        {scanOpen && <SpoolmanScanDialog onClose={() => setScanOpen(false)} assignments={spoolmanSlotAssignments} />}
        {secondaryPanel && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2" role="presentation" onClick={() => setSecondaryPanel(null)}>
          <div role="dialog" aria-modal="true" aria-label={secondaryPanel === 'alerts' ? 'Farm alerts' : secondaryPanel === 'projects' ? 'Active projects' : 'Recent activity'} className={`max-h-[95vh] w-full max-w-2xl overflow-y-auto rounded-xl border p-3 ${theme.page}`} onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 flex justify-end"><button type="button" autoFocus onClick={() => setSecondaryPanel(null)} className={`min-h-11 rounded-lg border px-4 ${theme.panelSoft}`}>Close</button></div>
            {secondaryPanel === 'alerts' ? <AlertsPanel alerts={activeAlerts} theme={theme} /> : secondaryPanel === 'projects' ? <ActiveProjectsPanel projects={activeProjects} theme={theme} /> : <ActivityPanel items={[...printing, ...paused, ...stopped, ...offline, ...errors]} theme={theme} />}
          </div>
        </div>}
      </main>
    );
  }

  return (
    <main className={`min-h-screen overflow-x-hidden ${theme.page}`} data-monitor-theme={mode}>
      <div className={`min-h-screen w-full max-w-full p-3 sm:p-4 xl:p-5 ${theme.backdrop}`}>
        <header className={`mb-4 flex min-w-0 flex-col gap-4 border-b pb-4 xl:flex-row xl:items-center xl:justify-between ${theme.divider}`}>
          <div className="flex min-w-0 flex-wrap items-center gap-3 sm:gap-5">
            <Link
              to="/farm-command-center"
              aria-label="Back to Farm Command Center"
              className={`flex h-11 w-11 items-center justify-center rounded-xl border ${theme.border} ${theme.panelSoft} ${theme.muted} transition hover:text-white`}
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className={`flex items-center gap-3 border-r pr-4 sm:pr-8 ${theme.divider}`}>
              <img src={appAssetPath(theme.logoPath)} alt="Printbuddy" className="h-12 w-auto" />
            </div>
            <h1 className={`min-w-0 truncate text-2xl font-bold tracking-tight sm:text-3xl ${theme.text}`}>Print Farm Monitor</h1>
            <button type="button" onClick={() => setScanOpen(true)} className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 text-sm font-semibold ${theme.panelSoft} ${theme.text}`}><ScanLine className="h-5 w-5" /> Scan Filament</button>
          </div>
          <div className="flex min-w-0 flex-col gap-3 xl:items-end">
            <div className="text-left xl:text-right">
              <div className="font-mono text-2xl font-bold tracking-wider text-blue-300 sm:text-3xl">{formatHeaderTime(now)}</div>
              <div className={`text-xs ${theme.muted}`}>{formatHeaderDate(now)}</div>
            </div>
            <div className="grid w-full min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,9.5rem),1fr))] gap-3 xl:min-w-[50rem]">
              <StatTile icon={PrinterIcon} label="Total Printers" value={printers.length} theme={theme} />
              <StatTile icon={PlayCircle} label="Printing Now" value={printing.length} tone="green" theme={theme} />
              <StatTile icon={PauseCircle} label="Idle" value={idle.length} tone="blue" theme={theme} />
              <StatTile icon={Power} label="Offline" value={offline.length} tone="gray" theme={theme} />
              <StatTile icon={Layers} label="Queue Size" value={(queue as PrintQueueItem[]).length} tone="purple" theme={theme} />
              <StatTile icon={AlertTriangle} label="Active Alerts" value={activeAlerts.length} tone="amber" theme={theme} />
            </div>
          </div>
        </header>

        <div data-testid="farm-monitor-layout" className="grid w-full min-w-0 max-w-full gap-4 min-[1280px]:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <div data-testid="farm-monitor-main-column" className="grid min-w-0 content-start gap-4">
            <section data-testid="farm-monitor-status-strip" className={`min-w-0 rounded-2xl border px-4 py-4 sm:px-5 ${theme.panelSoft}`}>
              <div className="flex min-w-0 flex-wrap items-center gap-4 text-base sm:text-lg">
                <div className="inline-flex items-center gap-3 rounded-xl bg-status-ok/15 px-4 py-2 font-bold text-status-ok shadow-[0_0_22px_color-mix(in_srgb,var(--status-ok)_18%,transparent)]">
                  <span className="h-4 w-4 rounded-full bg-status-ok shadow-[0_0_16px_color-mix(in_srgb,var(--status-ok)_60%,transparent)]" />
                  {printing.length} PRINTERS ACTIVE
                </div>
                <span className="hidden h-5 w-px bg-bambu-dark-tertiary md:block" />
                <div className={`min-w-0 ${theme.muted}`}>
                  Next completion: <span className="font-bold text-bambu-green-light">{nextCompletion?.printer.name ?? 'No active print'}</span>
                  {nextCompletion?.status?.remaining_time !== null && nextCompletion?.status?.remaining_time !== undefined && <span> in <span className="text-bambu-green-light">{formatDuration(nextCompletion.status.remaining_time)}</span></span>}
                </div>
                <div className={`ml-0 flex items-center gap-3 text-sm lg:ml-auto ${theme.muted}`}>
                  <div className="relative h-12 w-12 rounded-full p-1" style={utilizationStyle} aria-label={`Farm utilization ${utilization}%`}>
                    <div className={`h-full w-full rounded-full ${theme.ringInner}`} />
                  </div>
                  <div><div className="text-xs uppercase">Farm Utilization</div><div className={`text-2xl font-bold ${theme.text}`}>{utilization}%</div></div>
                </div>
              </div>
            </section>

            <section data-testid="farm-monitor-printer-grid" className="grid min-w-0 auto-rows-fr grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4">
              {visiblePrinters.map((item) => <PrinterCard key={item.printer.id} item={item} loadedFilament={loadedFilaments.get(item.printer.id) ?? null} theme={theme} />)}
              {visiblePrinters.length === 0 && (
                <div className={`col-span-full rounded-2xl border border-dashed p-12 text-center ${theme.panelSoft}`}>
                  <PrinterIcon className={`mx-auto mb-4 h-14 w-14 ${theme.subtle}`} />
                  <h2 className={`text-2xl font-bold ${theme.text}`}>No printers configured</h2>
                  <p className={`mt-2 ${theme.muted}`}>Add printers in Printbuddy to populate the farm monitor.</p>
                </div>
              )}
            </section>
          </div>

          <aside data-testid="farm-monitor-sidebar" className="grid min-w-0 max-w-full content-start gap-4 overflow-hidden">
            <ActiveProjectsPanel projects={activeProjects} theme={theme} />
            <AlertsPanel alerts={activeAlerts} theme={theme} />
            <ActivityPanel items={[...printing, ...paused, ...stopped, ...offline, ...errors]} theme={theme} />
          </aside>
        </div>

        <footer className={`mt-4 flex flex-col gap-3 rounded-xl border px-6 py-4 md:flex-row md:items-center md:justify-between ${theme.footer}`}>
          <div className="flex items-center gap-3"><RefreshCw className="h-5 w-5" /> Last refreshed: {formatClock(now)} · every {refreshSeconds}s</div>
          <div className="flex items-center gap-3 text-emerald-300"><CheckCircle2 className="h-6 w-6" /> PrintBuddy is operational</div>
          <div className="flex flex-wrap items-center gap-6"><span className="flex items-center gap-2"><Server className="h-5 w-5" /> Printbuddy&nbsp; {version?.display_version ?? version?.version ? `v${version?.display_version ?? version?.version}` : ''}</span><span>{now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} • {formatClock(now)}</span></div>
        </footer>
      </div>
      {scanOpen && <SpoolmanScanDialog onClose={() => setScanOpen(false)} assignments={spoolmanSlotAssignments} />}
    </main>
  );
}
