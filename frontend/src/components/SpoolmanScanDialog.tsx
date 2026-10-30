import { useCallback, useEffect, useRef, useState } from 'react';
import { Barcode, PackageSearch, ScanLine, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api, type InventorySpool } from '../api/client';
import { parseSpoolmanSpoolId } from '../utils/spoolmanScan';

type Assignment = { printer_name: string | null; ams_label: string | null; ams_id: number; tray_id: number; spoolman_spool_id: number };

export function SpoolmanScanDialog({ onClose, assignments }: { onClose: () => void; assignments?: Assignment[] }) {
  const { data: fetchedAssignments = [], isError: assignmentsUnavailable } = useQuery({
    queryKey: ['spoolman-slot-assignments', 'scan'],
    queryFn: () => api.getSpoolmanSlotAssignments(),
    enabled: assignments === undefined,
    retry: false,
  });
  const [payload, setPayload] = useState('');
  const [manualId, setManualId] = useState('');
  const [spool, setSpool] = useState<InventorySpool | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const pendingRef = useRef(false);
  const lastRef = useRef<{ id: number; at: number } | null>(null);
  const scannerBuffer = useRef('');
  const scannerTime = useRef(0);

  const lookup = useCallback(async (value: string, manual = false) => {
    const id = parseSpoolmanSpoolId(value, manual);
    if (id === null) { setError(manual ? 'Enter a valid physical spool ID.' : 'This is not a supported Spoolman spool label.'); setSpool(null); return; }
    if (pendingRef.current || (lastRef.current?.id === id && Date.now() - lastRef.current.at < 1500)) return;
    pendingRef.current = true;
    lastRef.current = { id, at: Date.now() };
    const request = ++requestRef.current;
    setBusy(true); setError(null); setSpool(null);
    try {
      const result = await Promise.race([
        api.getSpoolmanInventorySpool(id),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Spoolman lookup timed out. Try again.')), 12000)),
      ]);
      if (request === requestRef.current) setSpool(result);
    } catch (cause) {
      if (request !== requestRef.current) return;
      if (cause instanceof ApiError) {
        setError(cause.status === 404 ? `Physical spool #${id} was not found.` : cause.status === 400 ? 'Spoolman is not configured or enabled.' : cause.status === 503 || cause.status === 502 ? 'Spoolman is unavailable. Try again.' : cause.message);
      } else setError(cause instanceof Error ? cause.message : 'Spool lookup failed. Try again.');
    } finally {
      if (request === requestRef.current) { pendingRef.current = false; setBusy(false); }
    }
  }, []);

  useEffect(() => { inputRef.current?.focus(); const currentRequest = requestRef; return () => { currentRequest.current++; }; }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
      // A scanner sends a fast burst of keys. Capture it even if focus drifted
      // to a button, without hijacking deliberate typing in another input.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === 'Enter') {
        if (scannerBuffer.current) { event.preventDefault(); void lookup(scannerBuffer.current); scannerBuffer.current = ''; }
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const now = Date.now();
        scannerBuffer.current = now - scannerTime.current > 120 ? event.key : scannerBuffer.current + event.key;
        scannerTime.current = now;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lookup, onClose]);

  const remaining = spool && spool.spoolman_remaining_known !== false ? Math.max(0, spool.label_weight - spool.weight_used) : null;
  const percent = spool && spool.spoolman_nominal_weight_known !== false && spool.label_weight > 0 && remaining !== null ? Math.round(remaining / spool.label_weight * 100) : null;
  const colors = spool ? [spool.rgba, ...(spool.extra_colors?.split(',') ?? [])].filter((color): color is string => Boolean(color && /^[#]?[a-f\d]{6}([a-f\d]{2})?$/i.test(color))) : [];
  const matching = spool ? (assignments ?? fetchedAssignments).filter((assignment) => assignment.spoolman_spool_id === spool.id) : [];
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-2" role="presentation">
    <section role="dialog" aria-modal="true" aria-label="Scan filament" className="flex h-full max-h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark p-3 text-white">
      <header className="flex shrink-0 items-center gap-3 border-b border-bambu-dark-tertiary pb-2"><ScanLine className="h-6 w-6 text-blue-300" /><h2 className="mr-auto text-xl font-bold">Scan Filament</h2><button type="button" onClick={onClose} className="flex min-h-11 items-center gap-2 rounded-lg border border-bambu-dark-tertiary px-4"><X className="h-5 w-5" /> Close</button></header>
      <div className="min-h-0 flex-1 overflow-y-auto py-4">
        <p className="mb-3 text-sm text-bambu-gray-light">Scan a Spoolman spool label, paste its QR text, or enter a physical spool ID. This view does not change inventory or printer assignments.</p>
        <form onSubmit={(event) => { event.preventDefault(); void lookup(payload); }} className="flex flex-wrap gap-2"><label className="min-w-[14rem] flex-1 text-sm">Label or QR payload<input ref={inputRef} value={payload} onChange={(event) => setPayload(event.target.value)} placeholder="WEB+SPOOLMAN:S-123" className="mt-1 h-12 w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 text-white" /></label><button type="submit" disabled={busy} className="self-end min-h-12 rounded-lg bg-blue-700 px-5 font-semibold disabled:opacity-50">Look up label</button></form>
        <form onSubmit={(event) => { event.preventDefault(); void lookup(manualId, true); }} className="mt-3 flex flex-wrap gap-2"><label className="min-w-[14rem] flex-1 text-sm">Manual physical spool ID<input inputMode="numeric" value={manualId} onChange={(event) => setManualId(event.target.value)} placeholder="Spool ID" className="mt-1 h-12 w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 text-white" /></label><button type="submit" disabled={busy} className="self-end min-h-12 rounded-lg border border-bambu-dark-tertiary px-5 font-semibold disabled:opacity-50">Find spool</button></form>
        {busy && <p role="status" className="mt-5 text-blue-300">Looking up physical spool…</p>}
        {error && <div role="alert" className="mt-5 rounded-lg border border-status-error/60 bg-status-error/10 p-4 font-medium text-red-900 dark:text-red-100">{error}</div>}
        {!busy && !error && !spool && <div className="mt-5 flex items-center gap-3 rounded-lg border border-dashed border-bambu-dark-tertiary p-5 text-bambu-gray-light"><Barcode className="h-8 w-8" /> Ready to scan</div>}
        {spool && <article className="mt-5 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4" aria-label={`Physical spool ${spool.id}`}>
          <div className="flex items-start gap-4"><div className="h-16 w-16 shrink-0 rounded-full border-4 border-white/30" style={{ background: colors.length > 1 ? `conic-gradient(${colors.map((color, index) => `#${color.replace('#', '').slice(0, 6)} ${index * 100 / colors.length}% ${(index + 1) * 100 / colors.length}%`).join(',')})` : colors[0] ? `#${colors[0].replace('#', '').slice(0, 6)}` : '#6b7280' }} aria-label={colors.length > 1 ? 'Multicolor filament' : 'Filament color'} /><div className="min-w-0"><p className="text-sm text-bambu-gray-light">Physical spool #{spool.id}{spool.spoolman_archived || spool.archived_at ? ' · Archived' : ''}</p><h3 className="break-words text-xl font-bold">{spool.slicer_filament_name || spool.subtype || 'Filament name unavailable'}</h3><p className="text-bambu-gray-light">{[spool.brand, spool.material, spool.color_name].filter(Boolean).join(' · ') || 'Filament details unavailable'}</p>{colors.length > 1 && <p className="text-sm text-blue-300">Multicolor · {colors.length} colors</p>}</div></div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3"><div><dt className="text-bambu-gray-light">Remaining</dt><dd className="text-lg font-semibold">{remaining === null ? 'Unavailable' : `${Math.round(remaining)} g`}</dd></div><div><dt className="text-bambu-gray-light">Remaining %</dt><dd className="text-lg font-semibold">{percent === null ? 'Unavailable' : `${percent}%`}</dd></div><div><dt className="text-bambu-gray-light">Nominal filament</dt><dd className="text-lg font-semibold">{spool.spoolman_nominal_weight_known !== false && spool.label_weight > 0 ? `${spool.label_weight} g` : 'Unavailable'}</dd></div><div><dt className="text-bambu-gray-light">Location</dt><dd>{spool.storage_location || 'Unassigned'}</dd></div><div><dt className="text-bambu-gray-light">Printer slots</dt><dd>{matching.length ? matching.map((assignment) => `${assignment.printer_name || 'Printer'} · ${assignment.ams_label || `Unit ${assignment.ams_id}`} slot ${assignment.tray_id}`).join(', ') : assignmentsUnavailable ? 'Assignments unavailable' : 'No known assignment'}</dd></div></dl>
        </article>}
      </div>
      <footer className="flex shrink-0 justify-end border-t border-bambu-dark-tertiary pt-2"><button type="button" onClick={() => { setPayload(''); setManualId(''); setSpool(null); setError(null); lastRef.current = null; inputRef.current?.focus(); }} className="flex min-h-11 items-center gap-2 rounded-lg border border-bambu-dark-tertiary px-4"><PackageSearch className="h-5 w-5" /> Scan another</button></footer>
    </section>
  </div>;
}
