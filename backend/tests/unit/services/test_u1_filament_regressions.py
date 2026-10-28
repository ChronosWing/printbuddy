"""Offline U1 contracts: real firmware shapes, no printer or Spoolman I/O."""

import json
from unittest.mock import AsyncMock, Mock
from zipfile import ZipFile

import pytest

from backend.app.services.archive import ThreeMFParser
from backend.app.services.printer_providers.moonraker import MoonrakerPrinterClient
from backend.app.services.spoolman_tracking import _report_spool_usage_for_slots, build_ams_tray_lookup
from backend.tests.unit.services.test_moonraker_provider import _moonraker_status_with_snapmaker_u1


def test_rgba_alpha_and_native_spoolman():
    client = MoonrakerPrinterClient("http://u1.invalid", printer_model="Snapmaker U1")
    status = _moonraker_status_with_snapmaker_u1()
    status["print_task_config"]["filament_color_rgba"][0] = "3366CC80"
    status["print_task_config"]["filament_spool_id"] = [42, 0, 0, 0]
    client._apply_snapmaker_u1_status(status)
    trays = client.state.raw_data["ams"][0]["tray"]
    assert len(trays) == 4
    assert trays[0]["tray_color"] == "#3366CC"
    assert trays[0]["native_spoolman"] is True
    assert trays[1]["native_spoolman"] is False
    assert trays[1]["remain"] is None


@pytest.fixture
def u1(monkeypatch):
    client = MoonrakerPrinterClient("http://u1.invalid", printer_model="Snapmaker U1")
    config = _moonraker_status_with_snapmaker_u1()["print_task_config"]
    monkeypatch.setattr(client, "_query_objects", Mock(return_value={"print_task_config": config}))
    monkeypatch.setattr(client, "_post", Mock())
    monkeypatch.setattr(client, "request_status_update", Mock(return_value=True))
    return client, config


def test_manual_edit_uses_native_command(u1):
    client, _ = u1
    client.configure_u1_filament(0, 2, "PLA", "PLA Basic", "#3366CC")
    client._post.assert_called_once_with(
        "printer/gcode/script",
        {
            "script": 'SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=2 VENDOR="Polymaker" '
            'FILAMENT_TYPE="PLA" FILAMENT_SUBTYPE="PLA Basic" FILAMENT_COLOR_RGBA=3366CC'
        },
    )
    client.request_status_update.assert_called_once()


@pytest.mark.parametrize("field,value", [("filament_official", True), ("filament_spool_id", 42)])
def test_native_managed_edit_is_not_forced(u1, field, value):
    client, config = u1
    config[field] = [0, 0, value, 0]
    with pytest.raises(PermissionError):
        client.configure_u1_filament(0, 2, "PLA", "Basic", "3366CCFF")
    client._post.assert_not_called()


@pytest.mark.parametrize("slot,material,color", [(4, "PLA", "3366CC"), (0, "PLA\nM112", "3366CC"), (0, "PLA", "xyz")])
def test_invalid_edits_do_not_send_commands(u1, slot, material, color):
    client, _ = u1
    with pytest.raises(ValueError):
        client.configure_u1_filament(0, slot, material, "Basic", color)
    client._post.assert_not_called()


async def test_native_spoolman_estimates_never_deduct_twice():
    client = AsyncMock()
    trays = build_ams_tray_lookup({"ams": [{"id": 0, "tray": [{"id": 0, "native_spoolman": True}]}]})
    result = await _report_spool_usage_for_slots(client, [(1, 12.5)], trays, None, "estimate")
    assert result == 0
    client.use_spool.assert_not_called()
    client.get_spools.assert_not_called()


def make_archive(tmp_path, files):
    path = tmp_path / "u1.3mf"
    with ZipFile(path, "w") as z:
        for name, value in files.items():
            z.writestr(name, value)
    return path


def test_orca_footer_retains_sparse_tool_indices(tmp_path):
    path = make_archive(
        tmp_path,
        {
            "Metadata/plate_1.gcode": "G1 X0\n" * 30000
            + "; filament used [g] = 0, 12.5, 0, 4.25\n; filament used [mm] = 0, 4100, 0, 1400\n",
            "Metadata/project_settings.config": json.dumps(
                {"filament_type": ["PLA"] * 4, "filament_colour": ["#FFFFFF", "#FF0000", "#FFFFFF", "#0000FF"]}
            ),
        },
    )
    result = ThreeMFParser(path).parse()
    from backend.app.utils.threemf_tools import extract_filament_usage_from_3mf

    assert extract_filament_usage_from_3mf(path) == result["filament_slots"]
    assert result["filament_used_grams"] == 16.75
    assert result["filament_used_mm"] == 5500
    assert result["filament_slots"] == [
        {"slot_id": 2, "used_g": 12.5, "type": "PLA", "color": "#FF0000"},
        {"slot_id": 4, "used_g": 4.25, "type": "PLA", "color": "#0000FF"},
    ]


def test_selected_plate_and_slice_info_precedence(tmp_path):
    path = make_archive(
        tmp_path,
        {
            "Metadata/plate_1.gcode": "; filament used [g] = 99\n",
            "Metadata/plate_2.gcode": "; filament used [g] = 0, 3\n",
            "Metadata/slice_info.config": '<config><plate><metadata key="index" value="1"/><filament id="1" used_g="99"/></plate><plate><metadata key="index" value="2"/><metadata key="weight" value="5"/><filament id="2" used_g="5" type="PETG" color="#123456"/></plate></config>',
        },
    )
    result = ThreeMFParser(path, plate_number=2).parse()
    assert result["filament_used_grams"] == 5
    assert result["filament_slots"] == [{"slot_id": 2, "used_g": 5, "type": "PETG", "color": "#123456"}]


@pytest.mark.parametrize("usage", ["nan, 2", "-1, 2", "broken, 2"])
def test_invalid_estimates_are_not_partial_or_shifted(tmp_path, usage):
    path = make_archive(tmp_path, {"Metadata/plate_1.gcode": f"; filament used [g] = {usage}\n"})
    result = ThreeMFParser(path).parse()
    assert "filament_slots" not in result
    assert "filament_used_grams" not in result


def test_unsliced_project_has_no_fabricated_usage(tmp_path):
    path = make_archive(tmp_path, {"Metadata/project_settings.config": json.dumps({"filament_type": ["PLA"]})})
    assert "filament_slots" not in ThreeMFParser(path).parse()


@pytest.mark.parametrize("kind", ["archive", "library"])
async def test_print_dialog_receives_footer_estimates(tmp_path, monkeypatch, kind):
    from types import SimpleNamespace

    from backend.app.api.routes import archives, library

    path = make_archive(
        tmp_path,
        {
            "Metadata/plate_1.gcode": "; filament used [g] = 0, 3.5\n; filament_type = PLA;PETG\n; filament_colour = #FFFFFF;#FF0000\n"
        },
    )
    entry = SimpleNamespace(file_path=str(path), filename=path.name, print_name="U1 test")
    db = AsyncMock()
    if kind == "archive":
        monkeypatch.setattr(archives.ArchiveService, "get_archive", AsyncMock(return_value=entry))
        result = await archives.get_filament_requirements(1, db=db)
    else:
        db.execute.return_value = Mock(scalar_one_or_none=Mock(return_value=entry))
        result = await library.get_library_file_filament_requirements(1, db=db)
    assert result["filaments"] == [
        {
            "slot_id": 2,
            "type": "PETG",
            "color": "#FF0000",
            "used_grams": 3.5,
            "used_meters": 0,
            "tray_info_idx": "",
            "used_in_plate": True,
        }
    ]


def test_single_plate_without_index_keeps_slice_metadata(tmp_path):
    path = make_archive(
        tmp_path,
        {
            "Metadata/slice_info.config": '<config><plate><metadata key="curr_bed_type" value="Textured PEI Plate"/><filament id="2" used_g="5"/></plate></config>'
        },
    )
    result = ThreeMFParser(path, plate_number=1).parse()
    assert result["bed_type"] == "Textured PEI Plate"
    assert result["filament_slots"][0]["slot_id"] == 2
