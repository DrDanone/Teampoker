# Wilkenpoker

Planning Poker für die Refinements: Teams schätzen verdeckt, decken gemeinsam auf und diskutieren die Ausreißer. Das Konzept steht in [`KONZEPT.md`](KONZEPT.md), die Arbeitspakete in den [Issues](https://github.com/DrDanone/Wilkenpoker/issues).

## Voraussetzungen

- Node.js 22 (siehe `.nvmrc`)

## Betrieb mit Docker

Für den Betrieb auf ZimaOS gibt es ein fertiges Image und eine Compose-Datei: Anleitung in [`docs/ZIMAOS.md`](docs/ZIMAOS.md).

```bash
docker compose up -d   # vorher ADMIN_PASSWORD in docker-compose.yml eintragen
```

## Lokal starten

```bash
npm install
npm run dev     # mit automatischem Neustart bei Änderungen
# oder
npm start
```

Danach ist die App unter <http://localhost:3000> erreichbar.

## Konfiguration

| Variable          | Standard      | Bedeutung                                                                              |
| ----------------- | ------------- | -------------------------------------------------------------------------------------- |
| `PORT`            | `3000`        | Port des Servers                                                                       |
| `DATA_DIR`        | `./data`      | Verzeichnis für Räume und Logo                                                         |
| `ADMIN_PASSWORD`  | –             | Passwort des Superadmins, Pflicht, mind. 12 Zeichen                                    |
| `ADMIN_NETWORKS`  | private Netze | Netze, aus denen `/admin/` erreichbar ist; über Tunnel/Proxy nie. `*` = überall        |
| `TRUSTED_PROXIES` | private Netze | Proxys/Tunnel, deren `CF-Connecting-IP` bzw. `X-Forwarded-For` als Client-Adresse gilt |

## Prüfen

```bash
npm test        # Tests
npm run lint    # ESLint und Prettier
npm run format  # Formatierung automatisch korrigieren
```

Die CI führt Lint, Tests und `npm audit` bei jedem Pull Request aus.

## Aufbau

```
server/   Node.js-Server (HTTP, WebSocket unter /ws, Konfiguration)
public/   Oberfläche, wird statisch ausgeliefert
test/     Tests mit dem eingebauten Test-Runner von Node.js
```

Endpunkte:

- `GET /healthz` – Gesundheitsprüfung für Docker
- `/ws` – WebSocket für Live-Updates

## Abhängigkeiten

Bewusst wenige:

- **Laufzeit:** [`ws`](https://github.com/websockets/ws) – WebSocket-Server. Node.js bringt bisher nur einen WebSocket-Client mit, keinen Server.
- **Entwicklung:** ESLint und Prettier für einheitlichen Code. Tests laufen mit dem eingebauten Test-Runner von Node.js, ohne zusätzliches Framework.

Den HTTP-Server stellt Node.js selbst bereit, ein Web-Framework ist nicht nötig.

## Gestaltung

Corporate Design **GY Utility**: Tokens und Grundelemente in `public/theme.css`. Schrift ist Aptos, wo installiert (Windows 11, Microsoft 365), sonst Segoe UI, Helvetica oder Arial. Icons sind [Material Symbols](https://fonts.google.com/icons) (Outlined, Weight 200, Apache 2.0) und liegen lokal unter `public/icons/` – die Seite lädt nichts von fremden Servern.
