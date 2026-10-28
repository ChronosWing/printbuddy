from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi import HTTPException

from backend.app.services.printer_providers.moonraker import MoonrakerPrinterClient


def test_delete_gcode_uses_encoded_moonraker_http_path(monkeypatch):
    requests = []

    def fake_delete(url, **kwargs):
        requests.append((url, kwargs))
        return httpx.Response(200, request=httpx.Request("DELETE", url), json={"action": "delete_file"})

    monkeypatch.setattr(httpx, "delete", fake_delete)
    client = MoonrakerPrinterClient("http://u1:7125", auth_token="secret")
    assert client.delete_file("gcodes/parts/Bracket #1 & lid.gcode", storage="gcodes") is True
    assert requests[0][0] == "http://u1:7125/server/files/gcodes/parts/Bracket%20%231%20%26%20lid.gcode"
    assert requests[0][1]["headers"] == {"Authorization": "Bearer secret"}


@pytest.mark.parametrize(
    "path", ["", "../other.gcode", "parts/../other.gcode", "parts//other.gcode", "parts\\other.gcode"]
)
def test_delete_rejects_unsafe_path_before_request(monkeypatch, path):
    delete = Mock()
    monkeypatch.setattr(httpx, "delete", delete)
    client = MoonrakerPrinterClient("http://u1:7125")
    with pytest.raises(ValueError):
        client.delete_file(path)
    delete.assert_not_called()


def test_delete_rejects_other_storage_root(monkeypatch):
    delete = Mock()
    monkeypatch.setattr(httpx, "delete", delete)
    client = MoonrakerPrinterClient("http://u1:7125")
    with pytest.raises(ValueError):
        client.delete_file("printer.cfg", storage="config")
    delete.assert_not_called()


@pytest.mark.parametrize("status", [401, 403, 404])
def test_delete_propagates_moonraker_status(monkeypatch, status):
    def fake_delete(url, **kwargs):  # noqa: ARG001
        return httpx.Response(status, request=httpx.Request("DELETE", url))

    monkeypatch.setattr(httpx, "delete", fake_delete)
    client = MoonrakerPrinterClient("http://u1:7125")
    with pytest.raises(httpx.HTTPStatusError) as exc:
        client.delete_file("part.gcode")
    assert exc.value.response.status_code == status


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403, 404])
async def test_file_manager_returns_moonraker_error_without_touching_archive(monkeypatch, tmp_path, status):
    from backend.app.api.routes import printers

    thumbnail = tmp_path / "thumbnail.png"
    thumbnail.write_bytes(b"archive thumbnail")
    request = httpx.Request("DELETE", "http://u1:7125/server/files/gcodes/part.gcode")
    response = httpx.Response(status, request=request)
    client = SimpleNamespace(
        delete_file=Mock(side_effect=httpx.HTTPStatusError("delete failed", request=request, response=response))
    )
    monkeypatch.setattr(printers, "_provider_for_printer", lambda printer: client)

    class FakeDb:
        calls = 0

        async def execute(self, query):  # noqa: ARG002
            self.calls += 1
            return SimpleNamespace(scalar_one_or_none=lambda: SimpleNamespace(provider="klipper"))

    db = FakeDb()
    with pytest.raises(HTTPException) as exc:
        await printers.delete_printer_file(7, "part.gcode", storage="gcodes", db=db)
    assert exc.value.status_code == status
    assert db.calls == 1
    assert thumbnail.read_bytes() == b"archive thumbnail"


@pytest.mark.asyncio
async def test_file_manager_success_only_calls_provider_delete(monkeypatch, tmp_path):
    from backend.app.api.routes import printers

    thumbnail = tmp_path / "thumbnail.png"
    thumbnail.write_bytes(b"archive thumbnail")
    client = SimpleNamespace(delete_file=Mock(return_value=True))
    monkeypatch.setattr(printers, "_provider_for_printer", lambda printer: client)

    class FakeDb:
        calls = 0

        async def execute(self, query):  # noqa: ARG002
            self.calls += 1
            return SimpleNamespace(scalar_one_or_none=lambda: SimpleNamespace(provider="klipper"))

    db = FakeDb()
    assert await printers.delete_printer_file(7, "parts/part.gcode", storage="gcodes", db=db) == {
        "status": "deleted",
        "path": "parts/part.gcode",
    }
    client.delete_file.assert_called_once_with("parts/part.gcode", storage="gcodes")
    assert db.calls == 1
    assert thumbnail.read_bytes() == b"archive thumbnail"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error, expected",
    [
        (httpx.ConnectError("offline"), 503),
        (httpx.ReadTimeout("timeout"), 504),
        (ValueError("Invalid Moonraker file path"), 400),
    ],
)
async def test_file_manager_handles_connection_and_validation_errors(monkeypatch, error, expected):
    from backend.app.api.routes import printers

    client = SimpleNamespace(delete_file=Mock(side_effect=error))
    monkeypatch.setattr(printers, "_provider_for_printer", lambda printer: client)

    class FakeDb:
        async def execute(self, query):  # noqa: ARG002
            return SimpleNamespace(scalar_one_or_none=lambda: SimpleNamespace(provider="klipper"))

    with pytest.raises(HTTPException) as exc:
        await printers.delete_printer_file(7, "part.gcode", storage="gcodes", db=FakeDb())
    assert exc.value.status_code == expected


@pytest.mark.asyncio
async def test_bambu_file_manager_delete_still_uses_ftp(monkeypatch):
    from backend.app.api.routes import printers

    monkeypatch.setattr(printers, "_provider_for_printer", lambda printer: None)
    calls = []

    async def fake_ftp_delete(ip, code, path, *, printer_model):
        calls.append((ip, code, path, printer_model))
        return True

    monkeypatch.setattr(printers, "delete_file_async", fake_ftp_delete)

    class FakeDb:
        async def execute(self, query):  # noqa: ARG002
            return SimpleNamespace(
                scalar_one_or_none=lambda: SimpleNamespace(
                    provider="bambu", ip_address="bambu.local", access_code="code", model="X1C"
                )
            )

    assert await printers.delete_printer_file(3, "/part.3mf", db=FakeDb()) == {"status": "deleted", "path": "/part.3mf"}
    assert calls == [("bambu.local", "code", "/part.3mf", "X1C")]
