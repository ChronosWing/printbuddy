# Snapmaker U1 development fork

This branch targets PrintBuddy v0.2.5.3 (`ae6c7d4a`) with U1 extended firmware
`2.0.0-paxx12-24-0de1a77`, based on stock `2.0.0.205`.
Development base: upstream `dev` at `386b3c6c`.
The Moonraker adapter and filament configuration route were unchanged between
that installed revision and this development base.

## Architecture and scope

PrintBuddy is a Python/FastAPI application with SQLAlchemy persistence and a
React/TypeScript/Vite frontend. `printer_manager` selects provider clients via
`services/printer_providers/factory.py`. The Moonraker provider polls printer
objects over HTTP and translates U1 feeders into the existing AMS-shaped state.
The status route serializes that state for the frontend. Archive metadata uses
`ThreeMFParser`; filament requirements also have library/archive route paths.

The canonical repository is https://github.com/vmhomelab/printbuddy, a fork of
Bambuddy. The root LICENSE identifies GNU AGPL version 3. Existing LICENSE and
attribution notices are retained unchanged.

## Changes

- The filament swatch accepts both `RRGGBB` and `#RRGGBB`. Previously the U1
  value became invalid CSS such as `##E72F1D`.
- The status response retains U1 detected/preloaded/in-extruder state and active
  tool information. Unknown remaining weight uses the existing negative sentinel
  rather than failing validation on null or presenting it as zero.
- Explicit `filament_color_rgba` is decoded as RRGGBBAA even for partial alpha.
- The slot configuration endpoint dispatches U1 manual metadata edits to
  `SET_PRINT_FILAMENT_CONFIG`, not Bambu AMS/K-calibration methods. Invalid
  input returns 422, protected/unsupported slots return 409, and transport
  failures return 502. Color, material and subtype are supported; vendor is
  preserved. Bambu temperature/K-profile parameters are not applied to U1.
- RFID/Spoolman-managed slots cannot be forcibly overridden. No `FORCE`,
  `FILAMENT_SPOOL_ID`, spool assignment, or consumption command is sent by edits.
  Use the firmware's Filament Manager for managed slots. This patch does not add
  a new U1 editor UI; it fixes the existing configuration API path.
- Sliced Orca 3MF files can provide per-tool grams and total length through G-code
  footer comments. The selected plate is respected, zero positions retain their
  indices, and slice metadata takes priority. The archive and print-dialog paths
  use these estimates. Unsliced projects do not acquire invented usage.
- Slots with a positive native `filament_spool_id` carry ownership into the
  Spoolman tracking snapshot. Completed/partial estimate reporting skips those
  slots, preserving firmware deductions.

RTSP/camera code, production configuration, firmware, and databases are not
changed. No production printer or Spoolman endpoint was used in development.

## Offline checks

Use a separate Python 3.12 virtual environment, install `requirements.txt` and
`requirements-dev.txt`, and run `PYTHON=/path/to/venv/bin/python
./scripts/test_u1_offline.sh`. Tests use synthetic firmware-shaped responses,
ZIP fixtures, and in-memory SQLite. They never require printer credentials.

Frontend checks after `npm ci`:

```
npx vitest run src/__tests__/components/FilamentSlotCircle.test.tsx src/__tests__/pages/PrintersPage.test.tsx
npx tsc -b --pretty false
```

## Remaining validation

A representative affected sliced 3MF and sanitized `print_task_config` plus
`filament_feed left/right` status are needed to verify the exact reported
four-slot issue against the physical U1. All current fixtures are synthetic.
Slicer slot IDs are logical tool positions; custom runtime tool remapping must
be checked against a real file before promising physical-toolhead attribution.
This work does not make an unsliced 3MF contain estimates and does not address
BuddyDash's separate offline indication. No production deployment was performed.

## Firmware contracts consulted

- https://github.com/Snapmaker/u1-klipper/blob/main/klippy/extras/print_task_config.py
- https://github.com/Snapmaker/u1-klipper/blob/main/klippy/extras/filament_feed.py
- https://github.com/paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware/tree/0de1a77/overlays/firmware-extended/13-patch-rfid/patches
- https://github.com/paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware/blob/0de1a77/overlays/firmware-extended/12-patch-moonraker/patches/home/lava/moonraker/01-metadata-filament-weights-colors.patch
