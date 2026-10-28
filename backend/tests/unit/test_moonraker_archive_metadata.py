from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from backend.app.services.printer_providers.moonraker import MoonrakerPrinterClient


def test_moonraker_metadata_uses_gcode_filename_and_caches(monkeypatch):
    client = MoonrakerPrinterClient("http://u1:7125")
    calls = []

    def fake_get(url, **kwargs):
        calls.append(url)
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json={"result": {"estimated_time": 3458, "filament_weights": [31.8, 0.07, 0, 0]}},
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    filename = "folder/U1 test.gcode"
    assert client.get_file_metadata(filename)["estimated_time"] == 3458
    assert client.get_file_metadata(filename)["filament_weights"][1] == 0.07
    assert calls == ["http://u1:7125/server/files/metadata?filename=folder%2FU1%20test.gcode"]


def test_moonraker_archive_metadata_and_missing_values():
    from backend.app.main import _normalize_moonraker_file_metadata

    metadata = _normalize_moonraker_file_metadata(
        {
            "estimated_time": 3458,
            "layer_count": 175,
            "filament_weight_total": 31.87,
            "filament_weights": [31.8, 0.07, 0, 0],
            "thumbnails": [],
        }
    )
    assert metadata["print_time_seconds"] == 3458
    assert metadata["total_layers"] == 175
    assert metadata["filament_used_grams"] == pytest.approx(31.87)
    assert metadata["filament_weights"] == [31.8, 0.07, 0, 0]
    assert _normalize_moonraker_file_metadata({}) == {}
    assert _normalize_moonraker_file_metadata({"slicer": "OrcaSlicer"}) == {}


@pytest.mark.asyncio
async def test_moonraker_thumbnail_is_persisted_locally(monkeypatch, tmp_path):
    from backend.app import main

    settings = SimpleNamespace(archive_dir=tmp_path / "archives", base_dir=tmp_path)
    client = SimpleNamespace(download_file=Mock(return_value=b"png image"))
    monkeypatch.setattr(main, "app_settings", settings)
    monkeypatch.setattr(main.printer_manager, "get_client", lambda _id: client)
    archive = SimpleNamespace(id=42, thumbnail_path=None)
    metadata = {
        "source": "moonraker",
        "thumbnails": [
            {"width": 96, "height": 96, "relative_path": ".thumbs/part-96.png"},
            {"width": 300, "height": 300, "relative_path": ".thumbs/part-300.png"},
        ],
    }
    await main._save_moonraker_archive_thumbnail(7, archive, "subdir/part.gcode", metadata, Mock())
    client.download_file.assert_called_once_with("subdir/.thumbs/part-300.png")
    assert (tmp_path / archive.thumbnail_path).read_bytes() == b"png image"

    client.download_file.reset_mock()
    await main._save_moonraker_archive_thumbnail(7, archive, "subdir/part.gcode", metadata, Mock())
    client.download_file.assert_not_called()

    empty_archive = SimpleNamespace(id=43, thumbnail_path=None)
    await main._save_moonraker_archive_thumbnail(7, empty_archive, "subdir/part.gcode", {"source": "moonraker"}, Mock())
    assert empty_archive.thumbnail_path is None
    client.download_file.assert_not_called()


@pytest.mark.asyncio
async def test_non_bambu_skips_ftp_timelapse(monkeypatch):
    from backend.app import main

    assert not main._should_attempt_bambu_ftp_archive(SimpleNamespace(provider="klipper"))
    assert main._should_attempt_bambu_ftp_archive(SimpleNamespace(provider="bambu"))
    assert await main._list_timelapse_videos(SimpleNamespace(provider="klipper")) == ([], None)

    from backend.app.services import bambu_ftp

    list_files = Mock(return_value=[{"name": "clip.mp4", "is_directory": False}])

    async def fake_list_files(*args, **kwargs):
        return list_files(*args, **kwargs)

    monkeypatch.setattr(bambu_ftp, "list_files_async", fake_list_files)
    files, path = await main._list_timelapse_videos(
        SimpleNamespace(provider="bambu", ip_address="bambu", access_code="code", model="X1C")
    )
    assert files[0]["name"] == "clip.mp4"
    assert path == "/timelapse"
    list_files.assert_called_once()


@pytest.mark.asyncio
async def test_u1_cover_uses_archived_thumbnail_without_ftp(monkeypatch, tmp_path):
    from backend.app.api.routes import printers

    thumbnail = tmp_path / "archives" / "7" / "42" / "thumbnail.png"
    thumbnail.parent.mkdir(parents=True)
    thumbnail.write_bytes(b"saved thumbnail")
    monkeypatch.setattr(printers, "settings", SimpleNamespace(base_dir=tmp_path))
    monkeypatch.setattr(
        printers.printer_manager,
        "get_status",
        lambda _id: SimpleNamespace(subtask_name="part.gcode", state="RUNNING"),
    )

    class FakeDb:
        async def execute(self, _query):
            if not hasattr(self, "queried_printer"):
                self.queried_printer = True
                return SimpleNamespace(scalar_one_or_none=lambda: SimpleNamespace(provider="klipper"))
            return SimpleNamespace(
                scalar_one_or_none=lambda: SimpleNamespace(thumbnail_path="archives/7/42/thumbnail.png")
            )

    response = await printers.get_printer_cover(7, db=FakeDb(), _=None)
    assert response.body == b"saved thumbnail"
