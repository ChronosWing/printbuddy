"""U1 API regressions using an in-memory database and mocked transport."""

from unittest.mock import Mock

import httpx
import pytest

from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_providers.moonraker import MoonrakerPrinterClient
from backend.tests.unit.services.test_moonraker_provider import _moonraker_status_with_snapmaker_u1


@pytest.fixture
def client_u1(monkeypatch):
    client = MoonrakerPrinterClient("http://u1.invalid", printer_model="Snapmaker U1")
    status = _moonraker_status_with_snapmaker_u1()
    client._apply_snapmaker_u1_status(status)
    monkeypatch.setattr(client, "_query_objects", Mock(return_value=status))
    monkeypatch.setattr(client, "_post", Mock())
    monkeypatch.setattr(client, "request_status_update", Mock(return_value=True))
    monkeypatch.setattr(printer_manager, "get_client", lambda _: client)
    monkeypatch.setattr(printer_manager, "get_status", lambda _: client.state)
    return client


async def test_status_preserves_u1_load_and_unknown_weight(async_client, printer_factory, client_u1):
    printer = await printer_factory(model="Snapmaker U1", provider="moonraker")
    response = await async_client.get(f"/api/v1/printers/{printer.id}/status")
    assert response.status_code == 200, response.text
    trays = response.json()["ams"][0]["tray"]
    assert len(trays) == 4
    assert trays[2]["loaded_to_extruder"] is True
    assert trays[2]["active"] is True
    assert trays[1]["loaded_to_feeder"] is True
    assert trays[1]["tray_color"] == "#080A0D"
    assert trays[1]["remain"] == -1


@pytest.mark.parametrize("slot,expected", [(2, 200), (0, 409), (5, 422)])
async def test_edit_routes_to_u1_without_bambu_calls(async_client, client_u1, slot, expected):
    response = await async_client.post(
        f"/api/v1/printers/1/slots/0/{slot}/configure",
        params={
            "tray_info_idx": "",
            "tray_type": "PLA",
            "tray_sub_brands": "Basic",
            "tray_color": "FF0000FF",
            "nozzle_temp_min": 190,
            "nozzle_temp_max": 220,
        },
    )
    assert response.status_code == expected, response.text
    if expected == 200:
        client_u1._post.assert_called_once()
    else:
        client_u1._post.assert_not_called()


async def test_transport_failure_is_not_success(async_client, client_u1):
    client_u1._post.side_effect = httpx.ReadTimeout("timeout")
    response = await async_client.post(
        "/api/v1/printers/1/slots/0/2/configure",
        params={
            "tray_info_idx": "",
            "tray_type": "PLA",
            "tray_sub_brands": "Basic",
            "tray_color": "FF0000FF",
            "nozzle_temp_min": 190,
            "nozzle_temp_max": 220,
        },
    )
    assert response.status_code == 502
    client_u1.request_status_update.assert_not_called()


async def test_status_exposes_native_inventory(async_client, printer_factory, client_u1):
    printer = await printer_factory(model="Snapmaker U1", provider="moonraker")
    status = _moonraker_status_with_snapmaker_u1()
    status["print_task_config"]["filament_spool_id"] = [38, 36, 31, 27]
    client_u1.state.connected = True
    client_u1._post.side_effect = lambda path, payload: {
        "id": int(payload["path"].split("/")[-1]),
        "remaining_weight": 0,
        "initial_weight": 500,
        "filament": {"name": "Matte Black", "vendor": {"name": "SnapSpeed"}},
    }
    client_u1._apply_snapmaker_u1_status(status)
    response = await async_client.get(f"/api/v1/printers/{printer.id}/status")
    assert response.status_code == 200
    trays = response.json()["ams"][0]["tray"]
    assert [t["spoolman_spool_id"] for t in trays] == [38, 36, 31, 27]
    assert trays[0]["remaining_weight"] == 0
    assert trays[0]["initial_weight"] == 500
    assert trays[0]["spoolman_filament_name"] == "Matte Black"
    assert trays[0]["spoolman_vendor"] == "SnapSpeed"
    assert trays[0]["native_spoolman"] is True
