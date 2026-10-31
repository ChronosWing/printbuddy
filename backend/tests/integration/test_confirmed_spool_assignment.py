"""Confirmed scanner assignments never issue commands to real printers."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient

from backend.app.models.printer import Printer


def u1_state(spool_id=None, *, connected=True, complete=True, status="IDLE"):
    return SimpleNamespace(
        connected=connected,
        state=status,
        raw_data={
            "ams": [
                {
                    "id": 0,
                    "module_type": "snapmaker_u1",
                    "native_spoolman_snapshot_complete": complete,
                    "tray": [
                        {"id": index, "spoolman_spool_id": spool_id if index == 0 else None, "native_spoolman": bool(spool_id) if index == 0 else False}
                        for index in range(4)
                    ],
                }
            ]
        },
    )


@pytest.fixture
async def setup_u1(db_session):
    from backend.app.models.settings import Settings

    printer = Printer(name="Test U1", serial_number="CONFIRMEDU1", ip_address="localhost", access_code="x", provider="klipper")
    db_session.add_all([printer, Settings(key="spoolman_enabled", value="true"), Settings(key="spoolman_url", value="http://localhost:7912")])
    await db_session.commit()
    await db_session.refresh(printer)
    return printer


@pytest.fixture
def mock_u1():
    spoolman = MagicMock()
    spoolman.get_spool = AsyncMock(return_value={"id": 42, "archived": False, "location": None})
    spoolman.health_check = AsyncMock(return_value=True)
    firmware = MagicMock()
    firmware.supports_u1_spool_assignment.return_value = True
    firmware.assign_u1_spool.return_value = True
    with (
        patch("backend.app.api.routes.spoolman_inventory._get_client", AsyncMock(return_value=spoolman)),
        patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_client", return_value=firmware),
    ):
        yield spoolman, firmware


def request(printer_id, *, expected=None, acknowledged=False):
    return {"printer_id": printer_id, "ams_id": 0, "tray_id": 0, "spoolman_spool_id": 42, "expected_spool_id": expected, "expected_slot_fingerprint": json.dumps([None, None, None, None, None, expected, None]), "replacement_acknowledged": acknowledged}


@pytest.mark.asyncio
async def test_u1_preview_and_verified_empty_assignment(async_client: AsyncClient, setup_u1, mock_u1):
    state = u1_state()
    _, firmware = mock_u1
    firmware.assign_u1_spool.side_effect = lambda *_: state.raw_data["ams"][0]["tray"][0].update({"spoolman_spool_id": 42, "native_spoolman": True})
    with (
        patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_status", return_value=state),
        patch("backend.app.services.spoolman_location_sync.printer_manager.get_status", return_value=state),
    ):
        preview = (await async_client.get("/api/v1/spoolman/inventory/confirmed-assignments/preview")).json()
        assert preview["printers"][0]["slots"][0]["available"] is True
        response = await async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=request(setup_u1.id))
        assert response.status_code == 200
        assert response.json()["printer_side"] == "verified"
        firmware.assign_u1_spool.assert_called_once_with(0, 42)


@pytest.mark.asyncio
async def test_u1_replacement_requires_acknowledgment_and_fresh_preview(async_client: AsyncClient, setup_u1, mock_u1):
    state = u1_state(17)
    with patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_status", return_value=state):
        assert (await async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=request(setup_u1.id, expected=17))).status_code == 409
        assert (await async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=request(setup_u1.id))).status_code == 409
        state.raw_data["ams"][0]["tray"][0]["spoolman_spool_id"] = 42
        same = await async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=request(setup_u1.id, expected=42))
        assert same.json()["outcome"] == "no_op"
    mock_u1[1].assign_u1_spool.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("state", [u1_state(connected=False), u1_state(complete=False), u1_state(status="RUNNING"), u1_state(status="PAUSE")])
async def test_unsafe_u1_state_rejected(async_client: AsyncClient, setup_u1, mock_u1, state):
    with patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_status", return_value=state):
        response = await async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=request(setup_u1.id))
    assert response.status_code == 409
    mock_u1[1].assign_u1_spool.assert_not_called()


@pytest.mark.asyncio
async def test_u1_unsupported_command_is_unavailable(async_client: AsyncClient, setup_u1, mock_u1):
    mock_u1[1].supports_u1_spool_assignment.return_value = False
    with patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_status", return_value=u1_state()):
        preview = (await async_client.get("/api/v1/spoolman/inventory/confirmed-assignments/preview")).json()
    assert preview["printers"][0]["slots"][0]["available"] is False


@pytest.mark.asyncio
async def test_u1_command_error_is_not_reported_as_success(async_client: AsyncClient, setup_u1, mock_u1):
    mock_u1[1].assign_u1_spool.side_effect = TimeoutError("response lost")
    with patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_status", return_value=u1_state()):
        response = await async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=request(setup_u1.id))
    assert response.json()["outcome"] == "unverified"


@pytest.mark.asyncio
async def test_u1_timeout_with_eventual_report_is_verified(async_client: AsyncClient, setup_u1, mock_u1):
    state = u1_state()
    def timeout_after_effect(*_):
        state.raw_data["ams"][0]["tray"][0].update({"spoolman_spool_id": 42, "native_spoolman": True})
        raise TimeoutError("response lost")
    mock_u1[1].assign_u1_spool.side_effect = timeout_after_effect
    with patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_status", return_value=state):
        response = await async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=request(setup_u1.id))
    assert response.json()["printer_side"] == "verified"
    mock_u1[1].assign_u1_spool.assert_called_once()


@pytest.mark.asyncio
async def test_u1_stale_fingerprint_rejected(async_client: AsyncClient, setup_u1, mock_u1):
    state = u1_state()
    state.raw_data["ams"][0]["tray"][0]["tray_color"] = "FF0000"
    with patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_status", return_value=state):
        response = await async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=request(setup_u1.id))
    assert response.status_code == 409
    mock_u1[1].assign_u1_spool.assert_not_called()


@pytest.mark.asyncio
async def test_loaded_u1_filament_without_physical_id_is_not_empty(async_client: AsyncClient, setup_u1, mock_u1):
    state = u1_state()
    state.raw_data["ams"][0]["tray"][0]["filament_detected"] = True
    with patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_status", return_value=state):
        preview = (await async_client.get("/api/v1/spoolman/inventory/confirmed-assignments/preview")).json()
        response = await async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=request(setup_u1.id))
    assert preview["printers"][0]["slots"][0]["available"] is False
    assert response.status_code == 409
    mock_u1[1].assign_u1_spool.assert_not_called()


@pytest.mark.asyncio
async def test_concurrent_u1_requests_do_not_both_write(async_client: AsyncClient, setup_u1, mock_u1):
    state = u1_state()
    entered = asyncio.Event()
    release = asyncio.Event()
    def assign(*_):
        state.raw_data["ams"][0]["tray"][0].update({"spoolman_spool_id": 42, "native_spoolman": True})
    async def mirror(*_):
        entered.set()
        await release.wait()
    mock_u1[1].assign_u1_spool.side_effect = assign
    with (
        patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_status", return_value=state),
        patch("backend.app.services.spoolman_location_sync.sync_native_spool_slots", side_effect=mirror),
    ):
        first = asyncio.create_task(async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=request(setup_u1.id)))
        await entered.wait()
        second = asyncio.create_task(async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=request(setup_u1.id)))
        release.set()
        responses = await asyncio.gather(first, second)
    assert sorted(response.status_code for response in responses) == [200, 409]
    mock_u1[1].assign_u1_spool.assert_called_once()


@pytest.mark.asyncio
async def test_verified_u1_reports_location_failure_separately(async_client: AsyncClient, db_session, setup_u1, mock_u1):
    setup_u1.spoolman_location_sync_enabled = True
    setup_u1.spoolman_location = "U1"
    await db_session.commit()
    state = u1_state()
    mock_u1[1].assign_u1_spool.side_effect = lambda *_: state.raw_data["ams"][0]["tray"][0].update({"spoolman_spool_id": 42, "native_spoolman": True})
    with (
        patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_status", return_value=state),
        patch("backend.app.services.spoolman_location_sync.sync_native_spool_slots", new_callable=AsyncMock),
        patch("backend.app.api.routes.spoolman_inventory.reconcile_spool_locations", new_callable=AsyncMock),
    ):
        response = await async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=request(setup_u1.id))
    assert response.json() == {"outcome": "partial_success", "printer_side": "verified", "printbuddy": "saved", "location": "failed"}


@pytest.mark.asyncio
async def test_bambu_local_assignment_reports_unverified_printer_side(async_client: AsyncClient, db_session, mock_u1):
    printer = Printer(name="Bambu", serial_number="CONFIRMEDAMS", ip_address="localhost", access_code="x", provider="bambu")
    db_session.add(printer)
    await db_session.commit()
    await db_session.refresh(printer)
    state = SimpleNamespace(connected=True, state="IDLE", raw_data={"ams": [{"id": 0, "tray": [{"id": 0, "state": 9}]}]})
    with (
        patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_status", return_value=state),
        patch("backend.app.api.routes.spoolman_inventory._assign_spoolman_slot_impl", new_callable=AsyncMock) as legacy,
    ):
        legacy.return_value = {"printer_side": "failed"}
        payload = request(printer.id)
        payload["expected_slot_fingerprint"] = json.dumps([9, None, None, None, None, None, None])
        response = await async_client.post("/api/v1/spoolman/inventory/confirmed-assignments", json=payload)
    assert response.json()["outcome"] == "partial_success"
    assert response.json()["printer_side"] == "failed"
    legacy.assert_awaited_once()


@pytest.mark.asyncio
async def test_bambu_external_slot_uses_reported_shape(async_client: AsyncClient, db_session, mock_u1):
    printer = Printer(name="Bambu external", serial_number="CONFIRMEDVIRTUAL", ip_address="localhost", access_code="x", provider="bambu")
    db_session.add(printer)
    await db_session.commit()
    state = SimpleNamespace(connected=True, state="IDLE", raw_data={"ams": [], "vt_tray": {"id": 254, "state": 9}})
    with patch("backend.app.api.routes.spoolman_inventory.printer_manager.get_status", return_value=state):
        preview = (await async_client.get("/api/v1/spoolman/inventory/confirmed-assignments/preview")).json()
    assert [(slot["ams_id"], slot["tray_id"], slot["available"]) for slot in preview["printers"][0]["slots"]] == [(255, 0, True)]
