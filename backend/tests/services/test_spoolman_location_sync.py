"""Location synchronization follows committed slot bindings, never weight state."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from backend.app.models.printer import Printer
from backend.app.models.spoolman_slot_assignment import SpoolmanSlotAssignment
from backend.app.services.spoolman import SpoolmanClient
from backend.app.services.spoolman_location_sync import reconcile_spool_locations, sync_native_spool_slots


@pytest.mark.asyncio
async def test_printer_location_settings_default_off_and_survive_reload(db_session):
    from sqlalchemy import select

    printer = Printer(
        id=1,
        name="Printer 1",
        serial_number="TEST1",
        ip_address="localhost",
        access_code="test",
        provider="bambu",
    )
    db_session.add(printer)
    await db_session.commit()
    db_session.expire_all()
    loaded = (await db_session.execute(select(Printer).where(Printer.id == 1))).scalar_one()
    assert loaded.spoolman_location_sync_enabled is False
    assert loaded.spoolman_location is None
    loaded.spoolman_location_sync_enabled = True
    loaded.spoolman_location = "Previously configured"
    await db_session.commit()
    db_session.expire_all()
    reloaded = (await db_session.execute(select(Printer).where(Printer.id == 1))).scalar_one()
    assert reloaded.spoolman_location_sync_enabled is True
    assert reloaded.spoolman_location == "Previously configured"


async def add_printer(db, printer_id: int, location: str, *, enabled: bool = True, provider: str = "bambu"):
    printer = Printer(
        id=printer_id,
        name=f"Printer {printer_id}",
        serial_number=f"TEST{printer_id}",
        ip_address="localhost",
        access_code="test",
        provider=provider,
        spoolman_location_sync_enabled=enabled,
        spoolman_location=location,
    )
    db.add(printer)
    await db.commit()
    return printer


async def bind(db, printer_id: int, spool_id: int, tray_id: int = 0):
    db.add(SpoolmanSlotAssignment(printer_id=printer_id, ams_id=0, tray_id=tray_id, spoolman_spool_id=spool_id))
    await db.commit()


def client(current_location: str | None):
    mock = AsyncMock(spec=SpoolmanClient)
    mock.get_spool.return_value = {"id": 42, "location": current_location}
    return mock


def complete_status():
    return SimpleNamespace(
        connected=True,
        raw_data={"ams": [{"id": 0, "tray": [{"id": index} for index in range(4)]}]},
    )


@pytest.mark.asyncio
async def test_location_choices_filter_unassigned_and_preserve_exact_names():
    spoolman = SpoolmanClient("http://localhost:7912")
    spoolman._get_with_retry = AsyncMock(
        return_value=[{"key": None}, {"key": ""}, {"key": "P1S"}, {"key": "U1"}, {"key": "P1S"}]
    )
    assert await spoolman.get_locations() == ["P1S", "U1"]
    spoolman._get_with_retry.assert_awaited_once_with(
        "/spool/group", params={"group_by": "location", "allow_archived": "true"}
    )


@pytest.mark.asyncio
async def test_location_patch_changes_only_location():
    spoolman = SpoolmanClient("http://localhost:7912")
    response = AsyncMock()
    response.json = lambda: {"location": None}
    spoolman._request_spool = AsyncMock(return_value=response)
    await spoolman.set_spool_location(42, None)
    spoolman._request_spool.assert_awaited_once_with(
        "PATCH", 42, json_body={"location": None}, operation="update-location"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,location", [("bambu", "P1S"), ("bambu", "A1"), ("klipper", "U1")])
async def test_assignment_sets_configured_location(db_session, provider, location):
    await add_printer(db_session, 1, location, provider=provider)
    await bind(db_session, 1, 42)
    spoolman = client(None)
    with patch("backend.app.services.spoolman_location_sync.printer_manager.get_status", return_value=None):
        await reconcile_spool_locations(db_session, spoolman, {42})
    spoolman.set_spool_location.assert_awaited_once_with(42, location)


@pytest.mark.asyncio
async def test_removal_clears_only_after_last_slot(db_session):
    await add_printer(db_session, 1, "Custom shelf")
    await bind(db_session, 1, 42, 0)
    await bind(db_session, 1, 42, 1)
    spoolman = client("Custom shelf")
    with patch(
        "backend.app.services.spoolman_location_sync.printer_manager.get_status",
        return_value=complete_status(),
    ):
        await reconcile_spool_locations(db_session, spoolman, {42})
        spoolman.set_spool_location.assert_not_awaited()
        from sqlalchemy import delete

        await db_session.execute(delete(SpoolmanSlotAssignment).where(SpoolmanSlotAssignment.tray_id == 0))
        await db_session.commit()
        await reconcile_spool_locations(db_session, spoolman, {42})
        spoolman.set_spool_location.assert_not_awaited()
        await db_session.execute(delete(SpoolmanSlotAssignment))
        await db_session.commit()
        await reconcile_spool_locations(db_session, spoolman, {42})
    spoolman.set_spool_location.assert_awaited_once_with(42, None)


@pytest.mark.asyncio
async def test_move_and_conflict(db_session):
    await add_printer(db_session, 1, "P1S")
    await add_printer(db_session, 2, "A1")
    await bind(db_session, 1, 42)
    await bind(db_session, 2, 42)
    spoolman = client("P1S")
    with patch("backend.app.services.spoolman_location_sync.printer_manager.get_status", return_value=None):
        await reconcile_spool_locations(db_session, spoolman, {42})
        spoolman.set_spool_location.assert_not_awaited()
        from sqlalchemy import delete

        await db_session.execute(delete(SpoolmanSlotAssignment).where(SpoolmanSlotAssignment.printer_id == 1))
        await db_session.commit()
        await reconcile_spool_locations(db_session, spoolman, {42})
    spoolman.set_spool_location.assert_awaited_once_with(42, "A1")


@pytest.mark.asyncio
async def test_shared_location_and_disabled_assignment(db_session):
    await add_printer(db_session, 1, "Shared")
    await add_printer(db_session, 2, "Shared")
    await bind(db_session, 1, 42)
    await bind(db_session, 2, 42)
    spoolman = client(None)
    with patch("backend.app.services.spoolman_location_sync.printer_manager.get_status", return_value=None):
        await reconcile_spool_locations(db_session, spoolman, {42})
        spoolman.set_spool_location.assert_awaited_once_with(42, "Shared")
        spoolman.set_spool_location.reset_mock()
        printer = await db_session.get(Printer, 2)
        printer.spoolman_location_sync_enabled = False
        await db_session.commit()
        await reconcile_spool_locations(db_session, spoolman, {42})
    spoolman.set_spool_location.assert_not_awaited()


@pytest.mark.asyncio
async def test_disconnected_native_printer_defers_clear(db_session):
    await add_printer(db_session, 1, "U1", provider="klipper")
    spoolman = client("U1")
    with patch("backend.app.services.spoolman_location_sync.printer_manager.get_status", return_value=None):
        await reconcile_spool_locations(db_session, spoolman, {42})
    spoolman.set_spool_location.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_spool_id_is_an_assignment(db_session):
    await add_printer(db_session, 1, "U1", provider="klipper")
    spoolman = client(None)
    status = SimpleNamespace(
        connected=True, raw_data={"ams": [{"tray": [{"native_spoolman": True, "spoolman_spool_id": 42}]}]}
    )
    with patch("backend.app.services.spoolman_location_sync.printer_manager.get_status", return_value=status):
        await reconcile_spool_locations(db_session, spoolman, {42})
    spoolman.set_spool_location.assert_awaited_once_with(42, "U1")


@pytest.mark.asyncio
async def test_failed_spoolman_patch_does_not_raise(db_session):
    await add_printer(db_session, 1, "P1S")
    await bind(db_session, 1, 42)
    spoolman = client(None)
    spoolman.set_spool_location.side_effect = OSError("offline")
    with patch("backend.app.services.spoolman_location_sync.printer_manager.get_status", return_value=None):
        await reconcile_spool_locations(db_session, spoolman, {42})
    spoolman.set_spool_location.assert_awaited_once()


@pytest.mark.asyncio
async def test_disabled_printer_never_clears_unmanaged_location(db_session):
    from sqlalchemy import delete

    await add_printer(db_session, 1, "P1S", enabled=False)
    await bind(db_session, 1, 42)
    spoolman = client("P1S")
    await db_session.execute(delete(SpoolmanSlotAssignment))
    await db_session.commit()
    await reconcile_spool_locations(db_session, spoolman, {42})
    spoolman.get_spool.assert_not_awaited()
    spoolman.set_spool_location.assert_not_awaited()


@pytest.mark.asyncio
async def test_disconnected_bambu_defers_managed_location_clear(db_session):
    from sqlalchemy import delete

    await add_printer(db_session, 1, "P1S")
    await bind(db_session, 1, 42)
    spoolman = client(None)
    with patch("backend.app.services.spoolman_location_sync.printer_manager.get_status", return_value=None):
        await reconcile_spool_locations(db_session, spoolman, {42})
        await db_session.execute(delete(SpoolmanSlotAssignment))
        await db_session.commit()
        spoolman.get_spool.return_value = {"id": 42, "location": "P1S"}
        spoolman.set_spool_location.reset_mock()
        await reconcile_spool_locations(db_session, spoolman, {42})
    spoolman.set_spool_location.assert_not_awaited()


@pytest.mark.asyncio
async def test_partial_ams_snapshot_defers_managed_location_clear(db_session):
    from sqlalchemy import delete

    await add_printer(db_session, 1, "A1")
    await bind(db_session, 1, 42)
    spoolman = client(None)
    with patch(
        "backend.app.services.spoolman_location_sync.printer_manager.get_status",
        return_value=SimpleNamespace(connected=True, raw_data={"ams": [{"id": 0, "tray": [{"id": 0}]}]}),
    ):
        await reconcile_spool_locations(db_session, spoolman, {42})
        await db_session.execute(delete(SpoolmanSlotAssignment))
        await db_session.commit()
        spoolman.get_spool.return_value = {"id": 42, "location": "A1"}
        spoolman.set_spool_location.reset_mock()
        await reconcile_spool_locations(db_session, spoolman, {42})
    spoolman.set_spool_location.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_snapshot_replaces_then_clears_only_after_complete_status(db_session):
    from sqlalchemy import text

    await add_printer(db_session, 1, "U1", provider="klipper")
    spoolman = client(None)
    status = complete_status()

    def snapshot(spool_id):
        return [
            {
                "id": 0,
                "tray": [
                    {
                        "id": index,
                        "native_spoolman": bool(spool_id) if index == 0 else False,
                        "spoolman_spool_id": spool_id if index == 0 else None,
                    }
                    for index in range(4)
                ],
            }
        ]

    with patch("backend.app.services.spoolman_location_sync.printer_manager.get_status", return_value=status):
        await sync_native_spool_slots(db_session, spoolman, 1, snapshot(42))
        spoolman.set_spool_location.assert_awaited_once_with(42, "U1")
        spoolman.set_spool_location.reset_mock()
        spoolman.get_spool.return_value = {"id": 42, "location": "U1"}
        await sync_native_spool_slots(db_session, spoolman, 1, snapshot(None)[:0])
        assert (await db_session.execute(text("SELECT count(*) FROM spoolman_native_slots"))).scalar_one() == 1
        status.connected = False
        await sync_native_spool_slots(db_session, spoolman, 1, snapshot(None))
        spoolman.set_spool_location.assert_not_awaited()
        status.connected = True
        status.raw_data = {"ams": snapshot(None)}
        await sync_native_spool_slots(db_session, spoolman, 1, snapshot(None))
    spoolman.set_spool_location.assert_awaited_once_with(42, None)


@pytest.mark.asyncio
async def test_replacement_clears_previous_and_assigns_new_spool(db_session):
    from sqlalchemy import update

    await add_printer(db_session, 1, "P1S")
    await bind(db_session, 1, 42)
    spoolman = client(None)
    with patch(
        "backend.app.services.spoolman_location_sync.printer_manager.get_status",
        return_value=complete_status(),
    ):
        await reconcile_spool_locations(db_session, spoolman, {42})
        spoolman.get_spool.side_effect = lambda spool_id: {
            "id": spool_id,
            "location": "P1S" if spool_id == 42 else None,
        }
        spoolman.set_spool_location.reset_mock()
        await db_session.execute(update(SpoolmanSlotAssignment).values(spoolman_spool_id=43))
        await db_session.commit()
        await reconcile_spool_locations(db_session, spoolman, {42, 43})
    assert spoolman.set_spool_location.await_count == 2
    spoolman.set_spool_location.assert_any_await(42, None)
    spoolman.set_spool_location.assert_any_await(43, "P1S")
