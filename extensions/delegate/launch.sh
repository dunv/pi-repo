#!@bash@
set -eu
umask 077
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ] || ! [[ "$2" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; then
  echo 'Expected runtime JSON, full task UUID and optional revision UUID' >&2
  exit 64
fi
if [ "$#" -eq 3 ] && ! [[ "$3" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; then
  echo 'Invalid revision UUID' >&2
  exit 64
fi
# Emit before waiting for a slot so Pui has output even while admission is blocked.
printf '[delegate] Launcher ready: task=%s revision=%s; acquiring worker slot\n' "$2" "${3:-initial}"
# Locks, not another scheduler: Pueue still owns process lifetime and completion.
# Prefer either free slot; if both are busy, wait without model polling/spawning.
exec 8>@state@/worker-0.lock
exec 9>@state@/worker-1.lock
if @flock@ -n 8; then
  exec 9>&-
elif @flock@ -n 9; then
  exec 8>&-
else
  exec 9>&-
  @flock@ 8
fi
exec @node@ @runner@ "$@"
