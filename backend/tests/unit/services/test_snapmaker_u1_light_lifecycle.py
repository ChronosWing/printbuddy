"""U1 light subscriptions follow the printer connection lifecycle."""

import asyncio
from types import SimpleNamespace

import pytest

from backend.app.services.printer_manager import PrinterManager


@pytest.mark.asyncio
async def test_u1_subscription_starts_and_stops_with_connection(monkeypatch):
    started = asyncio.Event()
    stopped = asyncio.Event()

    class Client:
        state = SimpleNamespace(connected=True)

        def connect(self):
            pass

        def disconnect(self, timeout=0):
            self.state.connected = False

        def _is_snapmaker_u1(self):
            return True

        async def watch_u1_cavity_light(self):
            started.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

    client = Client()
    monkeypatch.setattr("backend.app.services.printer_manager.create_printer_client", lambda *args, **kwargs: client)
    manager = PrinterManager()
    printer = SimpleNamespace(id=1, name="U1", serial_number="U1", provider="klipper", model="Snapmaker U1")
    assert await manager.connect_printer(printer) is True
    await asyncio.wait_for(started.wait(), 1)
    assert 1 in manager._u1_light_tasks
    manager.disconnect_printer(1)
    await asyncio.wait_for(stopped.wait(), 1)
    assert not manager._u1_light_tasks
