#!/usr/bin/env bash
# Boots the built image and checks the three surfaces the app exposes:
# the page, socket.io, and the embedded PeerJS signalling server.
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image-ref>}"
NAME="peermeet-smoke-$$"
BASE="http://127.0.0.1:3999"

cleanup() {
  echo "--- container logs (tail)"
  docker logs "$NAME" 2>&1 | tail -30 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$NAME" -p 127.0.0.1:3999:3000 "$IMAGE" >/dev/null

up=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "$BASE/"; then up=1; break; fi
  sleep 1
done
[ "$up" = 1 ] || { echo "FAIL: app did not answer on / within 30s"; exit 1; }
echo "ok: GET / -> 200"

sio=$(curl -fsS "$BASE/socket.io/?EIO=4&transport=polling")
echo "$sio" | grep -q '"sid"' || { echo "FAIL: socket.io handshake: $sio"; exit 1; }
echo "ok: socket.io polling handshake"

peer=$(curl -fsS "$BASE/peerjs/")
echo "$peer" | grep -q 'PeerJS Server' || { echo "FAIL: /peerjs/ banner: $peer"; exit 1; }
echo "ok: /peerjs/ signalling banner"

id=$(curl -fsS "$BASE/peerjs/peerjs/id")
[ -n "$id" ] || { echo "FAIL: /peerjs/peerjs/id returned empty"; exit 1; }
echo "ok: /peerjs/peerjs/id issues a peer id"

for _ in $(seq 1 20); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$NAME")
  [ "$status" = healthy ] && break
  sleep 2
done
[ "$status" = healthy ] || { echo "FAIL: container health is '$status'"; exit 1; }
echo "ok: container healthy"
