"""Native U1 Spoolman inventory: read-only proxy, authoritative per-tool IDs."""

from copy import deepcopy
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from backend.app.services.printer_manager import printer_state_to_dict
from backend.app.services.printer_providers.moonraker import MoonrakerPrinterClient
from backend.app.services.spoolman_tracking import _report_spool_usage_for_slots, build_ams_tray_lookup
from backend.tests.unit.services.test_moonraker_provider import _moonraker_status_with_snapmaker_u1

IDS = [38, 36, 31, 27]
WEIGHTS = [468.16708398144505, 300.5, 125.25, 0.0]
COLORS = ["000000FF", "FF0000FF", "F7BEA1FF", "0066FFFF"]


def spool(spool_id, weight):
    return {
        "id": spool_id,
        "remaining_weight": weight,
        "initial_weight": 500.0,
        "filament": {
            "name": f"Spool {spool_id}",
            "vendor": {"name": "SnapSpeed"},
            "material": "OTHER",
            "color_hex": "FFFFFF",
            "weight": 1000.0,
        },
    }


@pytest.fixture
def setup_u1(monkeypatch):
    client = MoonrakerPrinterClient("http://u1.invalid:7125", auth_token="test-token", printer_model="Snapmaker U1")
    client.state.connected = True
    status = deepcopy(_moonraker_status_with_snapmaker_u1())
    status["print_task_config"].update(
        filament_spool_id=IDS.copy(),
        filament_type=["PLA"] * 4,
        filament_color_rgba=COLORS.copy(),
        filament_exist=[True] * 4,
    )
    for module in ["filament_feed left", "filament_feed right"]:
        for channel in status[module].values():
            channel["filament_detected"] = True
    records = {key: spool(key, weight) for key, weight in zip(IDS, WEIGHTS, strict=True)}
    post = Mock(side_effect=lambda path, payload: records.get(int(payload["path"].split("/")[-1]), {}))
    monkeypatch.setattr(client, "_post", post)
    return client, status, records, post


def trays(client):
    return client.state.raw_data["ams"][0]["tray"]


def test_four_authoritative_ids_weight_colors_and_read_only_requests(setup_u1):
    client, status, _, post = setup_u1
    client._apply_snapmaker_u1_status(status)
    assert [t["spoolman_spool_id"] for t in trays(client)] == IDS
    assert [t["remaining_weight"] for t in trays(client)] == WEIGHTS
    assert [t["tray_color"] for t in trays(client)] == [f"#{c[:6]}" for c in COLORS]
    assert [t["tray_type"] for t in trays(client)] == ["PLA"] * 4
    assert [t["remain"] for t in trays(client)] == [94, 60, 25, 0]
    assert all(t["native_spoolman"] for t in trays(client))
    assert client.state.raw_data["ams"][0]["native_spoolman_snapshot_complete"] is True
    assert trays(client)[2]["loaded_to_extruder"] is True
    assert {call.args[1]["path"] for call in post.call_args_list} == {f"/v1/spool/{i}" for i in IDS}
    assert all(
        call.args[0] == "server/spoolman/proxy" and call.args[1]["request_method"] == "GET"
        for call in post.call_args_list
    )


@pytest.mark.parametrize("reported", [[38, 36, 31], [38, None, 31, 27], [38, "bad", 31, 27], [38, True, 31, 27]])
def test_missing_or_malformed_native_ids_do_not_mark_snapshot_complete(setup_u1, reported):
    client, status, _, _ = setup_u1
    status["print_task_config"]["filament_spool_id"] = reported
    client._apply_snapmaker_u1_status(status)
    assert client.state.raw_data["ams"][0]["native_spoolman_snapshot_complete"] is False


def test_explicit_zero_is_a_complete_empty_native_slot(setup_u1):
    client, status, _, _ = setup_u1
    status["print_task_config"]["filament_spool_id"] = [38, 0, 31, 27]
    client._apply_snapmaker_u1_status(status)
    assert client.state.raw_data["ams"][0]["native_spoolman_snapshot_complete"] is True
    assert trays(client)[1]["spoolman_spool_id"] is None


def test_cache_refresh_and_assignment_change_do_not_reuse_old_weight(setup_u1):
    client, status, records, post = setup_u1
    client._apply_snapmaker_u1_status(status)
    client._apply_snapmaker_u1_status(status)
    assert post.call_count == 4
    status["print_task_config"]["filament_spool_id"][0] = 99
    records[99] = spool(99, 12)
    client._apply_snapmaker_u1_status(status)
    assert post.call_count == 5
    assert trays(client)[0]["remaining_weight"] == 12
    assert 38 not in client._u1_spool_cache
    records[99]["remaining_weight"] = 11
    client._u1_spool_cache[99] = (0, client._u1_spool_cache[99][1])
    client._apply_snapmaker_u1_status(status)
    assert post.call_count == 6
    assert trays(client)[0]["remaining_weight"] == 11


def test_duplicate_ids_are_fetched_once(setup_u1):
    client, status, _, post = setup_u1
    status["print_task_config"]["filament_spool_id"] = [38] * 4
    client._apply_snapmaker_u1_status(status)
    assert post.call_count == 1
    assert [t["remaining_weight"] for t in trays(client)] == [WEIGHTS[0]] * 4


@pytest.mark.parametrize(
    "ids", [None, [], [0, -1, None, "bad"], [True, 38.5, "38.0", {}], [float("inf"), float("nan"), "inf", "nan"]]
)
def test_invalid_or_missing_ids_never_query_proxy(setup_u1, ids):
    client, status, _, post = setup_u1
    status["print_task_config"]["filament_spool_id"] = ids
    client._apply_snapmaker_u1_status(status)
    post.assert_not_called()
    assert all(t["spoolman_spool_id"] is None for t in trays(client))
    assert all(t["tray_type"] == "PLA" for t in trays(client))


@pytest.mark.parametrize("failure", ["timeout", "404", "missing", "wrong_id"])
def test_unavailable_inventory_keeps_native_filament_and_negative_cache(setup_u1, failure):
    client, status, records, post = setup_u1
    client._apply_snapmaker_u1_status(status)
    client._u1_spool_cache.clear()
    if failure == "timeout":
        post.side_effect = httpx.ConnectTimeout("unavailable")
    elif failure == "404":
        post.side_effect = httpx.HTTPStatusError(
            "missing", request=httpx.Request("POST", client.base_url), response=httpx.Response(404)
        )
    else:
        post.side_effect = None
        post.return_value = {} if failure == "missing" else spool(999, 100)
    client._apply_snapmaker_u1_status(status)
    assert client.state.connected is True
    assert all(t["remaining_weight"] is None for t in trays(client))
    assert all(t["remain"] is None for t in trays(client))
    assert all(t["native_spoolman"] for t in trays(client))
    assert [t["tray_color"] for t in trays(client)] == [f"#{c[:6]}" for c in COLORS]
    assert trays(client)[2]["loaded_to_extruder"] is True
    client._apply_snapmaker_u1_status(status)
    assert post.call_count == 8


@pytest.mark.parametrize("remaining", [None, -1, "NaN", "inf", True])
def test_invalid_weight_is_unknown_not_zero(setup_u1, remaining):
    client, status, records, _ = setup_u1
    records[38]["remaining_weight"] = remaining
    client._apply_snapmaker_u1_status(status)
    assert trays(client)[0]["remaining_weight"] is None
    assert trays(client)[0]["remain"] is None
    assert trays(client)[3]["remaining_weight"] == 0


def test_initial_weight_fallback_and_missing_capacity(setup_u1):
    client, status, records, _ = setup_u1
    records[38]["initial_weight"] = None
    records[36]["initial_weight"] = None
    records[36]["filament"]["weight"] = None
    client._apply_snapmaker_u1_status(status)
    assert trays(client)[0]["initial_weight"] == 1000
    assert trays(client)[0]["remain"] == 47
    assert trays(client)[1]["remaining_weight"] == 300.5
    assert trays(client)[1]["remain"] is None


def test_disconnected_and_generic_moonraker_do_not_fetch(setup_u1):
    client, status, _, post = setup_u1
    client.disconnect()
    client._apply_snapmaker_u1_status(status)
    post.assert_not_called()
    client.state.connected = True
    client.printer_model = "Generic Klipper"
    client._apply_snapmaker_u1_status(status)
    post.assert_not_called()


def test_websocket_status_retains_weight_and_load_state(setup_u1):
    client, status, _, _ = setup_u1
    client._apply_snapmaker_u1_status(status)
    serialized = printer_state_to_dict(client.state, 1, "Snapmaker U1")["ams"][0]["tray"]
    assert [t["remaining_weight"] for t in serialized] == WEIGHTS
    assert serialized[2]["loaded_to_extruder"] is True
    assert serialized[0]["spoolman_filament_name"] == "Spool 38"
    assert serialized[0]["spoolman_vendor"] == "SnapSpeed"


async def test_inventory_refresh_never_reports_consumption(setup_u1):
    client, status, _, post = setup_u1
    client._apply_snapmaker_u1_status(status)
    lookup = build_ams_tray_lookup(client.state.raw_data)
    spoolman = AsyncMock()
    count = await _report_spool_usage_for_slots(spoolman, [(i + 1, 10) for i in range(4)], lookup, None, "partial")
    assert count == 0
    assert spoolman.mock_calls == []
    assert all(call.args[1]["request_method"] == "GET" for call in post.call_args_list)


def test_http_proxy_uses_existing_connection_and_unwraps_result(monkeypatch):
    client = MoonrakerPrinterClient("http://u1.invalid:7125", auth_token="test-token", printer_model="Snapmaker U1")
    post = Mock(
        return_value=httpx.Response(
            200, request=httpx.Request("POST", client.base_url), json={"result": spool(38, 468.1)}
        )
    )
    monkeypatch.setattr("backend.app.services.printer_providers.moonraker.httpx.post", post)
    assert client._u1_spool_inventory(38)["remaining_weight"] == 468.1
    post.assert_called_once_with(
        "http://u1.invalid:7125/server/spoolman/proxy",
        json={"request_method": "GET", "path": "/v1/spool/38"},
        headers={"Authorization": "Bearer test-token"},
        timeout=5.0,
    )


async def test_legacy_spoolman_sync_cannot_adjust_native_spools(setup_u1, monkeypatch):
    from backend.app.services.spoolman import SpoolmanClient

    client, status, _, _ = setup_u1
    client._apply_snapmaker_u1_status(status)
    sync = SpoolmanClient("http://spoolman.invalid")
    update = AsyncMock()
    create = AsyncMock()
    monkeypatch.setattr(sync, "update_spool", update)
    monkeypatch.setattr(sync, "create_spool", create)
    for raw in trays(client):
        parsed = sync.parse_ams_tray(0, raw)
        assert parsed is not None
        assert await sync.sync_ams_tray(parsed, "U1") is None
    update.assert_not_called()
    create.assert_not_called()


async def test_direct_print_estimate_cannot_deduct_native_spools(setup_u1, monkeypatch):
    from backend.app.services import direct_print_tracking
    from backend.app.services.printer_manager import printer_manager

    client, status, _, _ = setup_u1
    client._apply_snapmaker_u1_status(status)
    monkeypatch.setattr(printer_manager, "get_status", lambda _: client.state)
    direct_print_tracking.register_direct_print_metadata(987, "native.gcode", 12.5)
    db = AsyncMock()
    assert await direct_print_tracking.report_spoolman_usage(987, {"filename": "native.gcode"}, db) == []
    db.execute.assert_not_called()


def test_assignment_removed_or_missing_record_never_keeps_old_weight(setup_u1):
    client, status, _, _ = setup_u1
    client._apply_snapmaker_u1_status(status)
    status["print_task_config"]["filament_spool_id"] = [0, 999, 31, 27]
    client._apply_snapmaker_u1_status(status)
    assert trays(client)[0]["spoolman_spool_id"] is None
    assert trays(client)[0].get("spoolman_filament_name") is None
    assert trays(client)[1]["remaining_weight"] is None
    assert trays(client)[1]["native_spoolman"] is True
    assert 38 not in client._u1_spool_cache


def test_failed_read_retries_after_negative_cache_expires(setup_u1):
    client, status, _, post = setup_u1
    post.side_effect = httpx.ConnectError("offline")
    client._apply_snapmaker_u1_status(status)
    client._u1_spool_cache = {key: (0, value) for key, (_, value) in client._u1_spool_cache.items()}
    post.side_effect = lambda path, payload: spool(int(payload["path"].split("/")[-1]), 7)
    client._apply_snapmaker_u1_status(status)
    assert post.call_count == 8
    assert all(t["remaining_weight"] == 7 for t in trays(client))
