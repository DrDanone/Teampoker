# Wilkenpoker auf ZimaOS installieren

Wilkenpoker läuft als ein Docker-Container. Diese Anleitung beschreibt die Installation auf ZimaOS; auf jedem anderen Docker-Host funktioniert es genauso.

## Überblick

| Was                 | Wert                                            |
| ------------------- | ----------------------------------------------- |
| Image               | `ghcr.io/drdanone/wilkenpoker:latest`           |
| Port im Container   | `3000` (in der Compose-Datei auf `8090` gelegt) |
| Daten (Räume, Logo) | Volume `/data` → `/DATA/AppData/wilkenpoker`    |
| Pflicht-Einstellung | `ADMIN_PASSWORD`, mindestens 12 Zeichen         |
| Verwaltung          | `http://<server>:8090/admin/`                   |

Das Image wird von GitHub Actions bei jedem Merge auf `main` gebaut (für `amd64` und `arm64`) und in der GitHub Container Registry veröffentlicht. Vorher läuft ein Rauchtest (`scripts/docker-smoke.sh`).

## 1. Zugriff auf das Image

Das Repository ist privat, deshalb ist auch das Image privat. ZimaOS muss sich einmalig bei GitHub anmelden:

1. Auf GitHub unter **Settings → Developer settings → Personal access tokens → Tokens (classic)** ein Token mit nur dem Recht **`read:packages`** erzeugen.
2. Per SSH auf dem ZimaOS-Server anmelden und ausführen:

   ```bash
   docker login ghcr.io -u DrDanone
   # als Passwort das Token einfügen
   ```

Alternative ohne Token: Unter **GitHub → Packages → wilkenpoker → Package settings** die Sichtbarkeit auf „Public“ stellen. Dann ist der Code im Image für jeden abrufbar – das Repository selbst bleibt privat.

## 2. Datenordner anlegen

Der Container läuft aus Sicherheitsgründen nicht als root, sondern als Benutzer mit der ID 1000. Der Datenordner muss diesem Benutzer gehören:

```bash
sudo mkdir -p /DATA/AppData/wilkenpoker
sudo chown 1000:1000 /DATA/AppData/wilkenpoker
```

Fehlt das, bricht der Container beim Start mit einer klaren Meldung ab („Datenverzeichnis … ist nicht beschreibbar“).

## 3. Container installieren

**Über die ZimaOS-Oberfläche:** App Store → **Custom Install** (bzw. „+“ → „Install a customized app“) → **Import** → Inhalt von `docker-compose.yml` einfügen. Danach bei den Umgebungsvariablen `ADMIN_PASSWORD` setzen und installieren.

**Oder per SSH:**

```bash
mkdir -p ~/wilkenpoker && cd ~/wilkenpoker
# docker-compose.yml aus dem Repository hierher kopieren und ADMIN_PASSWORD eintragen
docker compose up -d
```

Ohne `ADMIN_PASSWORD` startet Wilkenpoker absichtlich nicht.

## 4. Erster Start

1. `http://<server>:8090/admin/` öffnen und mit dem Passwort anmelden.
2. Einen Raum pro Team anlegen.
3. Code oder Einladungslink an das Team schicken.
4. Optional ein Logo hochladen.

## Update

**ZimaOS-Oberfläche:** bei der App „Update“ bzw. „Neu installieren“.

**SSH:**

```bash
cd ~/wilkenpoker
docker compose pull
docker compose up -d
```

Räume und Logo bleiben erhalten, sie liegen im Datenordner. Laufende Schätzrunden gehen bei einem Neustart verloren – also nicht während eines Refinements aktualisieren.

## Sicherung

Es reicht, den Datenordner zu sichern:

```bash
tar czf wilkenpoker-backup.tgz -C /DATA/AppData wilkenpoker
```

Er enthält `rooms.json` (Räume und Codes) und das Logo. Schätzungen werden nie gespeichert.

## Passwort ändern

`ADMIN_PASSWORD` in der Compose-Datei bzw. in den App-Einstellungen von ZimaOS ändern und den Container neu starten. Alle Admin-Sitzungen sind danach beendet.

Hinweis: Umgebungsvariablen sind für jeden mit Docker-Zugriff auf dem Server sichtbar (`docker inspect`). Das Passwort deshalb nirgends sonst verwenden.

## Fehlersuche

```bash
docker logs wilkenpoker          # Meldungen beim Start
docker inspect --format '{{.State.Health.Status}}' wilkenpoker   # healthy?
```

| Meldung                                     | Ursache und Lösung                      |
| ------------------------------------------- | --------------------------------------- |
| `ADMIN_PASSWORD ist nicht gesetzt`          | Passwort in der Compose-Datei eintragen |
| `muss mindestens 12 Zeichen lang sein`      | längeres Passwort wählen                |
| `Datenverzeichnis … ist nicht beschreibbar` | Schritt 2 (chown 1000:1000) ausführen   |
| `rooms.json ist beschädigt`                 | Datei aus der Sicherung zurückspielen   |
| `pull access denied` beim Installieren      | Schritt 1 (docker login) ausführen      |

## Zugriff von außen

Die Compose-Datei öffnet den Port nur im Heimnetz. Wie die Entwickler von außen zugreifen (VPN oder Tunnel mit HTTPS), wird in Issue #10 entschieden. Bitte **keine Portweiterleitung am Router** einrichten.
