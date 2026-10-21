#!/usr/bin/env bash
# Waits (up to $1 seconds, default 120) until an AMD render node exists and this user can open it.
# Used before starting Ollama at boot: the amdgpu device nodes appear after the user manager starts, and
# without render-group membership access only arrives with a desktop login (progress/26).
# Exits 0 either way, so Ollama still starts (on CPU) if there is no usable GPU.
deadline=$(( $(date +%s) + ${1:-120} ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  for n in /sys/class/drm/renderD*; do
    [ -e "$n/device/vendor" ] && [ "$(cat "$n/device/vendor")" = 0x1002 ] || continue
    dev="/dev/dri/$(basename "$n")"
    [ -r "$dev" ] && [ -w "$dev" ] && { echo "AMD GPU ready: $dev"; exit 0; }
  done
  sleep 2
done
echo "no accessible AMD render node after ${1:-120}s; Ollama will start without the GPU" >&2
exit 0
