#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
u1_test_dir="$(mktemp -d "${TMPDIR:-/tmp}/printbuddy-u1.XXXXXX")"
trap 'rm -rf "$u1_test_dir"' EXIT
export DATA_DIR="$u1_test_dir"
export LOG_TO_FILE=false
"${PYTHON:-python3}" -m pytest -q \
  backend/tests/unit/services/test_u1_filament_regressions.py \
  backend/tests/unit/services/test_u1_spoolman_inventory.py \
  backend/tests/unit/services/test_moonraker_provider.py \
  backend/tests/integration/test_u1_filament_api.py \
  backend/tests/unit/test_threemf_tools.py \
  backend/tests/unit/test_spoolman_tracking.py \
  backend/tests/unit/services/test_spoolman_tracking.py \
  backend/tests/unit/services/test_direct_print_tracking.py \
  backend/tests/unit/services/test_archive_plate_validation.py \
  backend/tests/integration/test_spoolman_tracking_slot_fallback.py
