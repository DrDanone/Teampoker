#!/usr/bin/env bash
# Rauchtest für das Docker-Image: startet den Container so gehärtet wie in
# docker-compose.yml und prüft Start, Benutzer, Persistenz und Header.
#
# Aufruf: scripts/docker-smoke.sh <image>
set -euo pipefail

IMAGE="${1:?Image fehlt}"
NAME="wilkenpoker-smoke"
PASSWORD="smoke-test-passwort-123"
PORT=18090
DATA="$(mktemp -d)"
chown 1000:1000 "$DATA" 2>/dev/null || sudo chown 1000:1000 "$DATA"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker rm -f "$NAME-nopw" >/dev/null 2>&1 || true
}
trap cleanup EXIT

start() {
  docker run -d --name "$NAME" \
    -e ADMIN_PASSWORD="$PASSWORD" \
    -p "$PORT:3000" \
    -v "$DATA:/data" \
    --user 1000:1000 --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges:true \
    "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    if [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = "healthy" ]; then return; fi
    sleep 2
  done
  docker logs "$NAME"
  echo "FEHLER: Container wird nicht healthy" >&2
  exit 1
}

echo "1. Ohne Passwort darf der Container nicht starten"
docker run --name "$NAME-nopw" "$IMAGE" >/dev/null 2>&1 && { echo "FEHLER: startete ohne Passwort" >&2; exit 1; }
docker logs "$NAME-nopw" 2>&1 | grep -q "ADMIN_PASSWORD ist nicht gesetzt"
echo "   ok"

echo "2. Start gehärtet, Healthcheck"
start
curl -fsS "http://127.0.0.1:$PORT/healthz" | grep -q ok
echo "   ok"

echo "3. Läuft nicht als root"
[ "$(docker exec "$NAME" id -u)" = "1000" ]
echo "   ok"

echo "4. Sicherheits-Header"
curl -fsSI "http://127.0.0.1:$PORT/" | grep -qi "content-security-policy: default-src 'self'"
echo "   ok"

echo "5. Raum anlegen"
LOGIN="$(curl -fsS -c /tmp/smoke-cookies -H 'content-type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" "http://127.0.0.1:$PORT/api/admin/login")"
CSRF="$(echo "$LOGIN" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')"
CODE="$(curl -fsS -b /tmp/smoke-cookies -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"name":"Smoke-Team"}' "http://127.0.0.1:$PORT/api/admin/rooms" | sed -E 's/.*"code":"([A-Z0-9]+)".*/\1/')"
[ "${#CODE}" = "8" ]
echo "   ok ($CODE)"

echo "6. Raum übersteht Neustart und Neuanlage des Containers"
docker rm -f "$NAME" >/dev/null
start
LOGIN="$(curl -fsS -c /tmp/smoke-cookies -H 'content-type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" "http://127.0.0.1:$PORT/api/admin/login")"
curl -fsS -b /tmp/smoke-cookies "http://127.0.0.1:$PORT/api/admin/rooms" | grep -q "$CODE"
echo "   ok"

echo "Alle Rauchtests bestanden."
