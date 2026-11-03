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
# Keep the existing slot filenames so old and new launchers share their locks.
# Prefer any free slot; if all six are busy, block on slot five without polling.
# Waiting on a new slot avoids queuing behind a long-lived legacy slot 0/1.
acquired=false
for slot in 0 1 2 3 4 5; do
  exec {worker_fd}>@state@/worker-$slot.lock
  if @flock@ -n "$worker_fd"; then
    acquired=true
    break
  fi
  exec {worker_fd}>&-
done
if [ "$acquired" = false ]; then
  exec {worker_fd}>@state@/worker-5.lock
  @flock@ "$worker_fd"
fi
exec @node@ @runner@ "$@"
