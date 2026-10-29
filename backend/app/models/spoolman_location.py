"""Persisted state for opt-in Spoolman location synchronization."""

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class SpoolmanLocationOwnership(Base):
    __tablename__ = "spoolman_location_ownership"

    spool_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    location: Mapped[str] = mapped_column(String(64), nullable=False)
    printer_id: Mapped[int] = mapped_column(Integer, nullable=False)


class SpoolmanNativeSlot(Base):
    __tablename__ = "spoolman_native_slots"

    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), primary_key=True)
    ams_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tray_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    spool_id: Mapped[int] = mapped_column(Integer, nullable=False)
