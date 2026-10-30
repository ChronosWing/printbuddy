"""Best-effort Spoolman location reconciliation from printer slot assignments."""

import asyncio
import logging

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.printer import Printer
from backend.app.models.spoolman_slot_assignment import SpoolmanSlotAssignment
from backend.app.services.printer_manager import printer_manager
from backend.app.services.spoolman import SpoolmanClient

logger = logging.getLogger(__name__)
_spool_locks: dict[int, asyncio.Lock] = {}


def _complete_slot_snapshot(state) -> bool:
    """Require a connected, full AMS/toolhead snapshot before clearing."""
    if not state or not state.connected or not isinstance(state.raw_data, dict):
        return False
    units = state.raw_data.get("ams")
    if not isinstance(units, list) or not units:
        return False
    if any(
        isinstance(unit, dict)
        and unit.get("module_type") == "snapmaker_u1"
        and unit.get("native_spoolman_snapshot_complete") is not True
        for unit in units
    ):
        return False
    for unit in units:
        if not isinstance(unit, dict) or not isinstance(unit.get("tray"), list):
            return False
        try:
            ams_id = int(unit.get("id", 0))
            tray_ids = {int(tray["id"]) for tray in unit["tray"] if isinstance(tray, dict)}
        except (KeyError, ValueError, TypeError):
            return False
        expected = 1 if ams_id == 255 or 128 <= ams_id <= 191 else 4
        if len(tray_ids) < expected:
            return False
    return True


def _native_spool_ids(printer_id: int) -> set[int]:
    """Read firmware-owned IDs only from connected printer status."""
    state = printer_manager.get_status(printer_id)
    if not state or not state.connected or not state.raw_data:
        return set()
    ams = state.raw_data.get("ams", [])
    if isinstance(ams, dict):
        ams = ams.get("ams", [])
    if not isinstance(ams, list):
        return set()
    ids: set[int] = set()
    for unit in ams:
        if not isinstance(unit, dict):
            continue
        for tray in unit.get("tray", []):
            if not isinstance(tray, dict) or tray.get("native_spoolman") is not True:
                continue
            spool_id = tray.get("spoolman_spool_id")
            if isinstance(spool_id, int) and spool_id > 0:
                ids.add(spool_id)
    return ids


async def reconcile_spool_locations(db: AsyncSession, client: SpoolmanClient, spool_ids: set[int]) -> None:
    """Recheck committed bindings under a per-spool lock before each location PATCH.

    Ambiguous locations and unavailable native-printer state fail closed. The
    caller's assignment transaction has already committed and is never undone.
    """
    for spool_id in sorted(spool_ids):
        if spool_id <= 0:
            continue
        async with _spool_locks.setdefault(spool_id, asyncio.Lock()):
            try:
                printers = list((await db.execute(select(Printer))).scalars().all())
                bindings = list(
                    (
                        await db.execute(
                            select(SpoolmanSlotAssignment).where(SpoolmanSlotAssignment.spoolman_spool_id == spool_id)
                        )
                    )
                    .scalars()
                    .all()
                )
                bound_ids = {row.printer_id for row in bindings}
                native_rows = await db.execute(
                    text("SELECT printer_id FROM spoolman_native_slots WHERE spool_id = :spool_id"),
                    {"spool_id": spool_id},
                )
                native_bound_ids = set(native_rows.scalars().all())
                bound_ids.update(native_bound_ids)
                for printer in printers:
                    if spool_id in _native_spool_ids(printer.id):
                        bound_ids.add(printer.id)
                bound_printers = [printer for printer in printers if printer.id in bound_ids]
                if any(
                    not (state := printer_manager.get_status(printer_id)) or not state.connected or not state.raw_data
                    for printer_id in native_bound_ids
                ):
                    logger.info("Deferring spool %s location update while a native printer is disconnected", spool_id)
                    continue
                owner_row = (
                    await db.execute(
                        text("SELECT location, printer_id FROM spoolman_location_ownership WHERE spool_id = :spool_id"),
                        {"spool_id": spool_id},
                    )
                ).first()
                owner = owner_row.location if owner_row else None
                # A disabled printer's assignment still prevents this helper from
                # rewriting or clearing its externally managed location.
                if any(not printer.spoolman_location_sync_enabled for printer in bound_printers):
                    if owner is not None:
                        await db.execute(
                            text("DELETE FROM spoolman_location_ownership WHERE spool_id = :spool_id"),
                            {"spool_id": spool_id},
                        )
                        await db.commit()
                    continue
                desired = {printer.spoolman_location for printer in bound_printers if printer.spoolman_location}
                if len(desired) > 1 or any(not printer.spoolman_location for printer in bound_printers):
                    logger.warning("Spool %s has conflicting or unconfigured printer locations", spool_id)
                    continue
                if not bound_printers:
                    # Only clear a location previously managed by this feature.
                    if owner is None:
                        continue
                    owner_printer = next((printer for printer in printers if printer.id == owner_row.printer_id), None)
                    if owner_printer is not None:
                        state = printer_manager.get_status(owner_printer.id)
                        if not _complete_slot_snapshot(state):
                            logger.info(
                                "Deferring spool %s location clear without a complete printer slot snapshot", spool_id
                            )
                            continue
                    uncertain = False
                    for printer in printers:
                        if not printer.spoolman_location_sync_enabled or printer.provider not in {
                            "klipper",
                            "mainsail",
                            "fluidd",
                        }:
                            continue
                        state = printer_manager.get_status(printer.id)
                        if not state or not state.connected or not state.raw_data:
                            uncertain = True
                            break
                    if uncertain:
                        logger.info(
                            "Deferring spool %s location clear while a native printer is disconnected", spool_id
                        )
                        continue
                target = next(iter(desired), None)
                current = await client.get_spool(spool_id)
                # A user-edited location is no longer ours to clear.
                if target is None and current.get("location") != owner:
                    await db.execute(
                        text("DELETE FROM spoolman_location_ownership WHERE spool_id = :spool_id"),
                        {"spool_id": spool_id},
                    )
                    await db.commit()
                    continue
                if current.get("location") != target:
                    await client.set_spool_location(spool_id, target)
                if target is None:
                    await db.execute(
                        text("DELETE FROM spoolman_location_ownership WHERE spool_id = :spool_id"),
                        {"spool_id": spool_id},
                    )
                else:
                    await db.execute(
                        text("DELETE FROM spoolman_location_ownership WHERE spool_id = :spool_id"),
                        {"spool_id": spool_id},
                    )
                    await db.execute(
                        text(
                            "INSERT INTO spoolman_location_ownership (spool_id, location, printer_id) "
                            "VALUES (:spool_id, :location, :printer_id)"
                        ),
                        {
                            "spool_id": spool_id,
                            "location": target,
                            "printer_id": min(printer.id for printer in bound_printers),
                        },
                    )
                await db.commit()
            except Exception:
                await db.rollback()
                logger.exception("Could not synchronize location for Spoolman spool %s", spool_id)


async def sync_native_spool_slots(db: AsyncSession, client: SpoolmanClient, printer_id: int, ams_data: list) -> None:
    """Mirror a complete native firmware slot snapshot without treating disconnects as removals."""
    state = printer_manager.get_status(printer_id)
    if not state or not state.connected or not isinstance(ams_data, list):
        return
    u1_units = [unit for unit in ams_data if isinstance(unit, dict) and unit.get("module_type") == "snapmaker_u1"]
    if u1_units:
        if len(ams_data) != 1 or len(u1_units) != 1:
            return
        unit = u1_units[0]
        if unit.get("native_spoolman_snapshot_complete") is not True or unit.get("id") != 0:
            return
        trays = unit.get("tray")
        if not isinstance(trays, list) or len(trays) != 4:
            return
        if any(
            not isinstance(tray, dict)
            or isinstance(tray.get("id"), bool)
            or not isinstance(tray.get("id"), int)
            for tray in trays
        ) or {tray["id"] for tray in trays} != set(range(4)):
            return
        for tray in trays:
            if "spoolman_spool_id" not in tray:
                return
            spool_id = tray["spoolman_spool_id"]
            if spool_id is not None and (
                isinstance(spool_id, bool) or not isinstance(spool_id, int) or spool_id <= 0
            ):
                return
            if tray.get("native_spoolman") is not (spool_id is not None):
                return
    slots: dict[tuple[int, int], int] = {}
    native_seen = False
    for unit in ams_data:
        if not isinstance(unit, dict) or not isinstance(unit.get("tray"), list):
            return
        try:
            ams_id = int(unit.get("id", 0))
            native_seen = native_seen or unit.get("module_type") == "snapmaker_u1"
            for tray in unit["tray"]:
                if not isinstance(tray, dict) or "native_spoolman" not in tray:
                    return
                native_seen = True
                tray_id = int(tray["id"])
                spool_id = tray.get("spoolman_spool_id")
                slots[(ams_id, tray_id)] = spool_id if isinstance(spool_id, int) and spool_id > 0 else 0
        except (ValueError, TypeError, KeyError):
            return
    # U1 reports four independent toolheads. Do not infer removals from a
    # partial status payload, or from a generic printer's AMS event.
    if not native_seen or len(slots) < 4:
        return
    rows = await db.execute(
        text("SELECT ams_id, tray_id, spool_id FROM spoolman_native_slots WHERE printer_id = :printer_id"),
        {"printer_id": printer_id},
    )
    previous = {(row.ams_id, row.tray_id): row.spool_id for row in rows}
    # Empty toolheads have no mirror row; compare only physical assignments.
    if previous == {slot: spool_id for slot, spool_id in slots.items() if spool_id}:
        return
    affected = set(previous.values()) | set(slots.values())
    await db.execute(
        text("DELETE FROM spoolman_native_slots WHERE printer_id = :printer_id"),
        {"printer_id": printer_id},
    )
    for (ams_id, tray_id), spool_id in slots.items():
        if spool_id:
            await db.execute(
                text(
                    "INSERT INTO spoolman_native_slots (printer_id, ams_id, tray_id, spool_id) VALUES (:printer_id, :ams_id, :tray_id, :spool_id)"
                ),
                {"printer_id": printer_id, "ams_id": ams_id, "tray_id": tray_id, "spool_id": spool_id},
            )
    await db.commit()
    await reconcile_spool_locations(db, client, affected)
