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

## Native Spoolman remaining weight

U1 native inventory is read through Moonraker's existing authenticated HTTP
connection: `POST /server/spoolman/proxy` transports a **GET** request with
`path: /v1/spool/<id>`. No separate Spoolman URL or PrintBuddy Spoolman setting
is required. IDs come only from `print_task_config.filament_spool_id[T0..T3]`;
colors, names, or materials are never used to resolve inventory.

The adapter caches successful inventory reads for 60 seconds and failed reads
for 15 seconds. New assignments fetch on the next printer-status poll; removed
IDs are evicted. A shared ID is fetched once per cache period. Disconnect clears
the cache. Failed refreshes expose unknown weight rather than stale grams,
without erasing native material, color, or load state. Invalid/missing IDs and
mismatched record IDs are ignored. A real zero is preserved as zero.

Both REST and WebSocket status expose `spoolman_spool_id`, `remaining_weight`,
`initial_weight`, `spoolman_filament_name`, `spoolman_vendor`, and
`native_spoolman`. Slot cards show grams to one decimal place, or `—` when
unavailable. Hover cards show the supplied manufacturer/name. Percentage bars
use initial weight (falling back to the filament's nominal weight); a missing
capacity does not hide a known gram quantity.

Native-managed slots are excluded from the existing completed/partial estimate
reporter, direct-file estimate deductions, automatic AMS synchronization, manual
AMS synchronization, and AMS-weight adjustments. They are skipped before empty
slot cleanup, so a protected slot is never interpreted as a removed spool.
Bambu and generic Moonraker providers retain their existing behavior.

Validation uses the supplied response shape and four independent IDs
`[38, 36, 31, 27]`. No live U1, Spoolman server, or production database is
contacted by these tests. Real inventory updates may appear up to one cache
period plus the normal printer poll interval later. The Docker image must be
built and the test container recreated on Unraid for hardware verification.

### Update the existing Unraid test checkout

Run from the existing **test** repository checkout (not production):

```sh
git diff --quiet && git diff --cached --quiet && \
  git fetch origin fix/snapmaker-u1-filament && \
  git switch fix/snapmaker-u1-filament && \
  git pull --ff-only origin fix/snapmaker-u1-filament && \
  docker build -t printbuddy-u1-test:latest .
```

The initial checks stop this command if tracked local edits exist; they do not
discard changes. This updates source and builds the test image only. Recreate
only the existing test container using its current Unraid template, preserving
host networking, `PORT=8005`, and the separate test appdata mount. A simple
container restart does not adopt a rebuilt image. Do not use the repository's
default Compose service, which is named `printbuddy` and uses production-like
defaults. No new production volume or database is needed.
