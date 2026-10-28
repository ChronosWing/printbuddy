from unittest.mock import Mock

import httpx
import pytest

from backend.app.services.printer_providers.moonraker import (
    MoonrakerPrinterClient,
    _u1_print_script,
    _u1_used_logical_tools,
)

METADATA = {
    "filament_weights": [2.56, 0.0, 13.7, 0.0],
    "filament_used_mm": [806.17, 0.0, 4315.2, 0.0],
    "filament_type": ["PLA", "PLA", "PETG", "PLA"],
    "layer_height": 0.2,
}


def test_u1_command_serialization_uses_real_metadata_and_selected_toolheads():
    command = _u1_print_script(
        "parts/Bracket 1.gcode",
        METADATA,
        [[2, 1], [0, 3]],
        bed_level=True,
        flow_calibrate=True,
        flow_calibrate_extruders=[3, 1],
        time_lapse_camera=False,
    )
    assert command == (
        'SDCARD_PRINT_FILE_WITH_PARAMETERS FILENAME="parts/Bracket 1.gcode" '
        'BED_LEVEL="1" FLOW_CALIBRATE="1" TIME_LAPSE_CAMERA="0" '
        'MAP_TABLE="[[0, 3], [2, 1]]" FLOW_CALIBRATE_EXTRUDERS="[1, 3]" '
        'LAYER_HEIGHT="0.2" FILAMENT_USED_G="[2.56, 0.0, 13.7, 0.0]" '
        'FILAMENT_USED_MM="[806.17, 0.0, 4315.2, 0.0]" '
        "FILAMENT_TYPE=\"['PLA', 'PLA', 'PETG', 'PLA']\""
    )


@pytest.mark.parametrize(
    "mapping,flow_tools",
    [
        ([[0, 0]], []),  # Missing logical T2.
        ([[0, 0], [2, 0]], []),  # Duplicate physical toolhead.
        ([[0, 0], [1, 1]], []),  # Unused logical T1.
        ([[0, 0], [2, 4]], []),  # Outside U1's four toolheads.
        ([[0, 0], [2, 2]], [1]),  # Flow calibration on an unmapped toolhead.
    ],
)
def test_u1_command_rejects_invalid_mapping(mapping, flow_tools):
    with pytest.raises(ValueError):
        _u1_print_script(
            "part.gcode",
            METADATA,
            mapping,
            bed_level=True,
            flow_calibrate=bool(flow_tools),
            flow_calibrate_extruders=flow_tools,
            time_lapse_camera=False,
        )


def test_u1_missing_metadata_never_invents_used_tools():
    assert _u1_used_logical_tools({}) == []
    assert _u1_used_logical_tools({"filament_weights": [0, 0, 0, 0]}) == []
    with pytest.raises(ValueError, match="metadata"):
        _u1_print_script(
            "part.gcode",
            {},
            [[0, 0]],
            bed_level=True,
            flow_calibrate=False,
            flow_calibrate_extruders=[],
            time_lapse_camera=False,
        )


@pytest.mark.parametrize("filename", ["../part.gcode", "parts/../part.gcode", 'part".gcode', "part.gcode\nM112"])
def test_u1_start_rejects_unsafe_filenames(filename):
    with pytest.raises(ValueError, match="G-code|path"):
        _u1_print_script(
            filename,
            METADATA,
            [[0, 0], [2, 2]],
            bed_level=True,
            flow_calibrate=False,
            flow_calibrate_extruders=[],
            time_lapse_camera=False,
        )


def test_u1_start_checks_loaded_toolheads_before_sending(monkeypatch):
    client = MoonrakerPrinterClient("http://u1:7125", printer_model="Snapmaker U1")
    client.state.raw_data = {"ams": [{"tray": [{"id": 0, "filament_detected": True}]}]}
    monkeypatch.setattr(client, "get_file_metadata", lambda filename: {"filament_weights": [1, 0, 2, 0]})
    post = Mock(return_value={})
    monkeypatch.setattr(client, "_post", post)
    with pytest.raises(ValueError, match="no filament loaded"):
        client.start_print("part.gcode", u1_map_table=[[0, 0], [2, 2]])
    post.assert_not_called()
    client.state.raw_data["ams"][0]["tray"].append({"id": 2, "filament_detected": True})
    assert client.start_print("part.gcode", u1_map_table=[[0, 0], [2, 2]]) is True
    assert post.call_args.args[0] == "printer/gcode/script"


def test_u1_light_state_is_unknown_until_command_succeeds(monkeypatch):
    client = MoonrakerPrinterClient("http://u1:7125", printer_model="Snapmaker U1")
    assert client.state.chamber_light is None
    post = Mock(return_value={})
    monkeypatch.setattr(client, "_post", post)
    assert client.set_chamber_light(True) is True
    assert client.state.chamber_light is True
    post.assert_called_with("printer/gcode/script", {"script": "SET_LED LED=cavity_led WHITE=1"})
    assert client.set_chamber_light(False) is True
    post.assert_called_with("printer/gcode/script", {"script": "SET_LED LED=cavity_led WHITE=0"})


def test_u1_start_timeout_checks_whether_printer_accepted_command(monkeypatch):
    client = MoonrakerPrinterClient("http://u1:7125", printer_model="Snapmaker U1")
    client.state.raw_data = {"ams": [{"tray": [{"id": 0, "filament_detected": True}]}]}
    monkeypatch.setattr(client, "get_file_metadata", lambda filename: {"filament_weights": [1, 0, 0, 0]})
    post = Mock(side_effect=httpx.ReadTimeout("late response"))
    monkeypatch.setattr(client, "_post", post)

    def accepted():
        client.state.state = "RUNNING"
        client.state.current_print = "part.gcode"

    monkeypatch.setattr(client, "request_status_update", accepted)
    assert client.start_print("part.gcode", u1_map_table=[[0, 0]]) is True
    post.assert_called_once()


def test_u1_light_failure_keeps_unknown_state(monkeypatch):
    client = MoonrakerPrinterClient("http://u1:7125", printer_model="Snapmaker U1")
    monkeypatch.setattr(client, "_post", Mock(side_effect=httpx.ConnectError("offline")))
    with pytest.raises(httpx.ConnectError):
        client.set_chamber_light(True)
    assert client.state.chamber_light is None
