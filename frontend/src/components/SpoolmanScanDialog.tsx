import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Barcode, CheckCircle2, CircleHelp, PackageSearch, ScanLine, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api, type InventorySpool } from '../api/client';
import { parseSpoolmanSpoolId } from '../utils/spoolmanScan';
import { FilamentSpoolGraphic } from './FilamentSpoolGraphic';

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
  const [assignOpen, setAssignOpen] = useState(false);
  const [printerId, setPrinterId] = useState<number | null>(null);
  const [slotKey, setSlotKey] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [assignmentResult, setAssignmentResult] = useState<{ outcome: string; printer_side: string; printbuddy: string; location: string } | null>(null);
  const submittingRef = useRef(false);
  const { data: preview, refetch: refreshPreview, isFetching: previewLoading, isError: previewError } = useQuery({ queryKey: ['spool-assignment-preview'], queryFn: api.previewConfirmedSpoolAssignment, enabled: assignOpen && Boolean(spool), retry: false, staleTime: 0, refetchOnWindowFocus: false });
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
    setAssignOpen(false); setAssignmentResult(null); setPrinterId(null); setSlotKey(''); setAcknowledged(false);
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
  const selectedPrinter = preview?.printers.find((printer) => printer.printer_id === printerId);
  const selectedSlot = selectedPrinter?.slots.find((slot) => `${slot.ams_id}:${slot.tray_id}` === slotKey);
  const { data: existingSpool } = useQuery({ queryKey: ['spoolman-spool', selectedSlot?.current_spool_id], queryFn: () => api.getSpoolmanInventorySpool(selectedSlot!.current_spool_id!), enabled: assignOpen && Boolean(selectedSlot?.current_spool_id), retry: false });
  const confirmAssignment = async () => {
    if (!spool || !selectedPrinter || !selectedSlot || !selectedSlot.available || submittingRef.current) return;
    submittingRef.current = true; setBusy(true); setError(null);
    try {
      const result = await api.confirmSpoolAssignment({ spoolman_spool_id: spool.id, printer_id: selectedPrinter.printer_id, ams_id: selectedSlot.ams_id, tray_id: selectedSlot.tray_id, expected_spool_id: selectedSlot.current_spool_id, expected_slot_fingerprint: selectedSlot.fingerprint, replacement_acknowledged: acknowledged });
      setAssignmentResult(result);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 ? `${cause.message} Refresh destinations and review again.` : cause instanceof Error ? cause.message : 'Assignment failed.');
      setSlotKey(''); setAcknowledged(false); await refreshPreview();
    } finally { submittingRef.current = false; setBusy(false); }
  };
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-2" role="presentation">
    <section role="dialog" aria-modal="true" aria-label="Scan filament" className="flex h-full max-h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark p-3 text-white">
      <header className="flex shrink-0 items-center gap-3 border-b border-bambu-dark-tertiary pb-2"><ScanLine className="h-6 w-6 text-blue-700 dark:text-blue-300" /><h2 className="mr-auto text-xl font-bold">Scan Filament</h2><button type="button" onClick={onClose} className="flex min-h-11 items-center gap-2 rounded-lg border border-bambu-dark-tertiary px-4"><X className="h-5 w-5" /> Close</button></header>
      <div className="min-h-0 flex-1 overflow-y-auto py-4">
        {!assignOpen && <><p className="mb-3 text-sm text-bambu-gray-light">Scan a Spoolman spool label, paste its QR text, or enter a physical spool ID. Lookup does not change inventory or printer assignments.</p>
        <form onSubmit={(event) => { event.preventDefault(); void lookup(payload); }} className="flex flex-wrap gap-2"><label className="min-w-[14rem] flex-1 text-sm">Label or QR payload<input ref={inputRef} value={payload} onChange={(event) => setPayload(event.target.value)} placeholder="WEB+SPOOLMAN:S-123" className="mt-1 h-12 w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 text-white" /></label><button type="submit" disabled={busy} className="self-end min-h-12 rounded-lg bg-blue-700 px-5 font-semibold disabled:opacity-50">Look up label</button></form>
        <form onSubmit={(event) => { event.preventDefault(); void lookup(manualId, true); }} className="mt-3 flex flex-wrap gap-2"><label className="min-w-[14rem] flex-1 text-sm">Manual physical spool ID<input inputMode="numeric" value={manualId} onChange={(event) => setManualId(event.target.value)} placeholder="Spool ID" className="mt-1 h-12 w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 text-white" /></label><button type="submit" disabled={busy} className="self-end min-h-12 rounded-lg border border-bambu-dark-tertiary px-5 font-semibold disabled:opacity-50">Find spool</button></form></>}
        {busy && <p role="status" className="mt-5 text-blue-700 dark:text-blue-300">{assignOpen ? 'Checking assignment…' : 'Looking up physical spool…'}</p>}
        {error && <div role="alert" className="mt-5 rounded-lg border border-status-error/60 bg-status-error/10 p-4 font-medium text-red-900 dark:text-red-100">{error}</div>}
        {!busy && !error && !spool && <div className="mt-5 flex items-center gap-3 rounded-lg border border-dashed border-bambu-dark-tertiary p-5 text-bambu-gray-light"><Barcode className="h-8 w-8" /> Ready to scan</div>}
        {spool && <article className="mt-4 flex items-center gap-4 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3" aria-label={`Physical spool ${spool.id}`}>
          <FilamentSpoolGraphic colors={colors} size={assignOpen ? 58 : 88} label={`Physical spool ${spool.id} filament reel`} />
          <div className="min-w-0 flex-1"><p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">{spool.brand || 'Manufacturer unavailable'} · physical spool #{spool.id}</p><h3 className="truncate text-lg font-bold" title={spool.slicer_filament_name || spool.subtype || undefined}>{spool.slicer_filament_name || spool.subtype || 'Filament name unavailable'}</h3><p className="truncate text-sm text-bambu-gray-light">{[spool.material, spool.color_name].filter(Boolean).join(' · ') || 'Material unavailable'}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"><span>{remaining === null ? 'Weight unavailable' : `${Math.round(remaining)} g remaining`}</span><span>{percent === null ? 'Percentage unavailable' : `${percent}% remaining`}</span><span>Location: {spool.storage_location || 'Unassigned'}</span></div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/15" role="progressbar" aria-label="Filament remaining" aria-valuenow={percent ?? undefined} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-blue-400" style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} /></div>
            {!assignOpen && <p className="mt-2 truncate text-xs text-bambu-gray-light">{matching.length ? matching.map((assignment) => `${assignment.printer_name || 'Printer'} · ${assignment.ams_label || `Unit ${assignment.ams_id}`} slot ${assignment.tray_id}`).join(', ') : assignmentsUnavailable ? 'Assignments unavailable' : 'No known assignment'}</p>}
          </div>
        </article>}
        {spool && assignOpen && <div className="mt-3 flex justify-between gap-2"><button type="button" onClick={() => setAssignOpen(false)} className="min-h-11 rounded-lg border border-bambu-dark-tertiary px-3">Back to lookup</button>{!assignmentResult && <button type="button" onClick={() => { setSlotKey(''); setAcknowledged(false); void refreshPreview(); }} className="min-h-11 rounded-lg border border-bambu-dark-tertiary px-3">Refresh destinations</button>}</div>}
        {spool && !assignOpen && <button type="button" onClick={() => { setAssignOpen(true); setAssignmentResult(null); }} className="mt-4 min-h-12 rounded-lg bg-blue-700 px-5 font-semibold">Assign to Printer</button>}
        {spool && assignOpen && <div className="mt-4 space-y-3 rounded-xl border border-bambu-dark-tertiary p-3">
          {!assignmentResult && <>
          {previewLoading && <p role="status">Checking printer slots…</p>}{previewError && <p role="alert" className="text-red-100">Printer destinations are unavailable.</p>}
          <label className="block text-sm">Printer<select value={printerId ?? ''} onChange={(event) => { setPrinterId(Number(event.target.value) || null); setSlotKey(''); setAcknowledged(false); setAssignmentResult(null); }} className="mt-1 min-h-12 w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3"><option value="">Select printer</option>{preview?.printers.map((printer) => <option key={printer.printer_id} value={printer.printer_id}>{printer.name}</option>)}</select></label>
          {selectedPrinter && <div><p className="mb-2 text-sm font-semibold">Choose a slot or toolhead</p><div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Slot or toolhead">
            {selectedPrinter.slots.map((slot) => <button type="button" key={`${slot.ams_id}:${slot.tray_id}`} aria-pressed={slotKey === `${slot.ams_id}:${slot.tray_id}`} onClick={() => { setSlotKey(`${slot.ams_id}:${slot.tray_id}`); setAcknowledged(false); setAssignmentResult(null); }} className={`min-h-28 rounded-xl border p-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-300 ${slotKey === `${slot.ams_id}:${slot.tray_id}` ? 'border-blue-300 bg-blue-500/20' : slot.available ? 'border-bambu-dark-tertiary bg-bambu-dark-secondary hover:border-blue-400' : 'border-amber-500/60 bg-amber-500/10'}`}>
              <span className="flex items-center gap-2"><FilamentSpoolGraphic colors={[slot.color]} size={38} label={`${slot.label} filament reel`} /><span className="min-w-0"><strong className="block truncate">{slot.label}</strong><span className="block truncate text-xs text-bambu-gray-light">{slot.material || slot.filament_name || (slot.current_spool_id ? 'Material unknown' : 'Empty')}</span></span></span>
              <span className={`mt-2 block text-xs ${slot.available ? 'text-bambu-gray-light' : 'text-amber-900 dark:text-amber-100'}`}>{slot.available ? slot.current_spool_id ? `Occupied · spool #${slot.current_spool_id}` : 'Available · empty' : `Unavailable · ${slot.reason}`}</span>
            </button>)}
          </div></div>}
          {selectedPrinter && selectedPrinter.slots.length === 0 && <p className="text-sm text-bambu-gray-light">No reported assignable slots.</p>}
          {selectedSlot && <div className={`rounded-lg border p-3 text-sm ${selectedSlot.available ? 'border-bambu-dark-tertiary bg-bambu-dark-secondary' : 'border-amber-500/60 bg-amber-500/10'}`}><p className="font-semibold">{selectedPrinter?.name} · {selectedSlot.label}</p>{!selectedSlot.available && <p role="alert" className="mt-2 font-medium text-amber-900 dark:text-amber-100">{selectedSlot.reason}</p>}{selectedSlot.available && selectedSlot.current_spool_id === null && <p>Empty destination → physical spool #{spool.id}</p>}{selectedSlot.available && selectedSlot.current_spool_id !== null && <div className="mt-2 flex items-center justify-center gap-3"><div className="min-w-0 text-center"><FilamentSpoolGraphic colors={existingSpool ? [existingSpool.rgba, ...(existingSpool.extra_colors?.split(',') ?? [])] : [selectedSlot.color]} size={54} label="Existing filament reel" /><p className="truncate text-xs">{selectedSlot.mechanism === 'u1_native' ? 'Physical' : 'PrintBuddy-associated'} spool #{selectedSlot.current_spool_id}</p><p className="truncate text-xs text-bambu-gray-light">{existingSpool?.slicer_filament_name || selectedSlot.filament_name || selectedSlot.material || 'Filament unknown'}</p></div><span className="text-2xl text-amber-800 dark:text-amber-200" aria-hidden="true">→</span><div className="min-w-0 text-center"><FilamentSpoolGraphic colors={colors} size={54} label="Replacement filament reel" /><p className="truncate text-xs">Physical spool #{spool.id}</p><p className="truncate text-xs text-bambu-gray-light">{spool.slicer_filament_name || spool.material}</p></div></div>}</div>}
          {selectedSlot?.replacement_required && selectedSlot.current_spool_id !== spool.id && <label className="flex items-start gap-3 rounded-lg border border-amber-500/70 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1 h-5 w-5" /><span>I have physically unloaded or removed the existing filament from this slot and loaded the new spool.</span></label>}
          </>}
          {assignmentResult && <div role="status" className={`rounded-xl border p-4 text-sm ${assignmentResult.outcome === 'success' ? 'border-green-400/70 bg-green-500/10' : assignmentResult.outcome === 'no_op' ? 'border-blue-400/70 bg-blue-500/10' : 'border-amber-400/70 bg-amber-500/10'}`}>
            <div className="flex items-center gap-3"><FilamentSpoolGraphic colors={colors} size={48} label={`Assigned physical spool ${spool.id} filament reel`} />{assignmentResult.outcome === 'success' ? <CheckCircle2 className="h-7 w-7 text-green-700 dark:text-green-300" /> : assignmentResult.outcome === 'no_op' ? <CircleHelp className="h-7 w-7 text-blue-700 dark:text-blue-300" /> : <AlertTriangle className="h-7 w-7 text-amber-800 dark:text-amber-200" />}<div><p className="text-lg font-bold capitalize">{assignmentResult.outcome.replaceAll('_', ' ')}</p><p className="truncate">{selectedPrinter?.name} · {selectedSlot?.label} · physical spool #{spool.id} · {spool.slicer_filament_name || spool.subtype || spool.material}</p></div></div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">{[['Printer assignment', assignmentResult.printer_side], [selectedSlot?.mechanism === 'u1_native' ? 'PrintBuddy inventory mirror' : 'PrintBuddy association', assignmentResult.printbuddy], ['Spoolman location', assignmentResult.location]].map(([label, value]) => <div key={label} className="rounded-lg bg-black/20 p-2"><p className="text-xs text-bambu-gray-light">{label}</p><p className="flex items-center gap-1 font-semibold capitalize">{value === 'verified' || value === 'saved' || value === 'synchronized' ? <CheckCircle2 className="h-4 w-4 text-green-700 dark:text-green-300" /> : <CircleHelp className="h-4 w-4 text-amber-800 dark:text-amber-200" />}{value.replaceAll('_', ' ')}</p></div>)}</div>
            {assignmentResult.outcome === 'unverified' && <p className="mt-3 text-amber-900 dark:text-amber-100">The U1 firmware may or may not have accepted the command. Inspect the printer's current assignment before trying another change.</p>}
            {assignmentResult.printbuddy === 'saved' && assignmentResult.printer_side !== 'verified' && <p className="mt-3 text-amber-900 dark:text-amber-100">PrintBuddy saved the inventory association. The printer's reported filament state has not been verified.</p>}
            {assignmentResult.location === 'failed' && <p className="mt-3 text-amber-900 dark:text-amber-100">The assignment and Spoolman location update are separate operations. Check the location in Spoolman.</p>}
          </div>}
        </div>}
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-bambu-dark-tertiary pt-2">{assignOpen && selectedSlot && !assignmentResult && <button type="button" disabled={busy || !selectedSlot.available || (selectedSlot.replacement_required && selectedSlot.current_spool_id !== spool?.id && !acknowledged)} onClick={() => void confirmAssignment()} className="min-h-11 rounded-lg bg-blue-700 px-5 font-semibold disabled:opacity-50">Confirm assignment</button>}<button type="button" onClick={() => { setPayload(''); setManualId(''); setSpool(null); setError(null); setAssignOpen(false); setAssignmentResult(null); lastRef.current = null; inputRef.current?.focus(); }} className="flex min-h-11 items-center gap-2 rounded-lg border border-bambu-dark-tertiary px-4"><PackageSearch className="h-5 w-5" /> Scan another</button></footer>
    </section>
  </div>;
}
