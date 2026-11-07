# Wilkenpoker auf ZimaOS installieren

Wilkenpoker läuft als ein Docker-Container. Diese Anleitung beschreibt die Installation auf ZimaOS; auf jedem anderen Docker-Host funktioniert es genauso.

## Überblick

| Was                  | Wert                                                      |
| -------------------- | --------------------------------------------------------- |
| Image                | `ghcr.io/drdanone/wilkenpoker:latest`                     |
| Port im Container    | `3000` (in der Compose-Datei auf `8090` gelegt)           |
| Daten (Räume, Logo)  | Volume `/data` → `/DATA/AppData/wilkenpoker`              |
| Pflicht-Einstellung  | `ADMIN_PASSWORD`, mindestens 12 Zeichen                   |
| Verwaltung           | `http://<server>:8090/admin/` – **nur im Heimnetz**       |
| Zugriff für das Team | `https://poker.<deine-domain>` über den Cloudflare Tunnel |

Das Image wird von GitHub Actions bei jedem Merge auf `main` gebaut (für `amd64` und `arm64`) und in der GitHub Container Registry veröffentlicht. Vorher läuft ein Rauchtest (`scripts/docker-smoke.sh`).

## 1. Image öffentlich stellen (einmalig)

Das Image wird beim ersten Merge auf `main` veröffentlicht – zunächst privat, weil das Repository privat ist. Damit ZimaOS es ohne Token laden kann, die Sichtbarkeit einmalig umstellen:

1. Auf GitHub ins eigene Profil → Reiter **Packages** → **wilkenpoker**.
2. **Package settings** → ganz unten **Change visibility** → **Public** → mit dem Paketnamen bestätigen.

Danach kann jeder das Image laden und den Code darin einsehen; das Repository selbst (Issues, Historie) bleibt privat. Geheimnisse stehen nicht im Image – das Passwort kommt erst über die Compose-Datei hinzu.

<details>
<summary>Alternative: privates Image mit Token</summary>

Das Repository ist privat, deshalb ist auch das Image zunächst privat. ZimaOS kann sich dann einmalig bei GitHub anmelden:

1. Auf GitHub unter **Settings → Developer settings → Personal access tokens → Tokens (classic)** ein Token mit nur dem Recht **`read:packages`** erzeugen.
2. Per SSH auf dem ZimaOS-Server anmelden und ausführen:

   ```bash
   docker login ghcr.io -u DrDanone
   # als Passwort das Token einfügen
   ```

</details>

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

`PUBLIC_URL` auf die öffentliche Adresse setzen, z. B. `https://poker.<deine-domain>`. Die Verwaltung läuft nur im Heimnetz – ohne diese Angabe würden kopierte Einladungslinks auf die Heimnetz-Adresse zeigen und bei Kollegen außerhalb nicht funktionieren.

## 4. Erster Start

1. `http://<server>:8090/admin/` öffnen und mit dem Passwort anmelden.
2. Einen Raum pro Team anlegen.
3. Code oder Einladungslink an das Team schicken (der Link nutzt `PUBLIC_URL`).
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

| Meldung                                     | Ursache und Lösung                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ADMIN_PASSWORD ist nicht gesetzt`          | Passwort in der Compose-Datei eintragen                                                    |
| `muss mindestens 12 Zeichen lang sein`      | längeres Passwort wählen                                                                   |
| `Datenverzeichnis … ist nicht beschreibbar` | Schritt 2 (chown 1000:1000) ausführen                                                      |
| `rooms.json ist beschädigt`                 | Datei aus der Sicherung zurückspielen                                                      |
| `pull access denied` beim Installieren      | Schritt 1 (Image öffentlich stellen) prüfen                                                |
| `/admin/` zeigt „Nicht gefunden“            | Verwaltung nur direkt im Heimnetz: `http://<server-ip>:8090/admin/`, nicht über die Domain |

## Zugriff von außen über den Cloudflare Tunnel

Die Entwickler erreichen Wilkenpoker über den bestehenden Cloudflare Tunnel unter einer eigenen Subdomain, z. B. `https://poker.<deine-domain>`. HTTPS übernimmt Cloudflare. Am Router wird **kein Port** freigegeben.

### Public Hostname anlegen

1. [Cloudflare Zero Trust](https://one.dash.cloudflare.com) → **Networks → Tunnels** → den bestehenden Tunnel → **Public Hostname** (bzw. „Published application routes“) → **Add**.
2. Eintragen:
   - **Subdomain:** `poker` (oder nach Wunsch), **Domain:** deine Domain
   - **Service:** Typ `HTTP`, URL `<ZimaOS-IP>:8090` (läuft `cloudflared` als Container im selben Docker-Netz wie Wilkenpoker, geht auch `wilkenpoker:3000`)
3. Unter **Additional application settings → HTTP Settings** das Feld **HTTP Host Header leer lassen**. Wilkenpoker prüft, dass Anfragen von der eigenen Domain kommen; ein überschriebener Host-Header würde das stören.
4. Speichern.

### Einstellungen der Domain prüfen

Im Cloudflare-Dashboard der Domain:

- **Network → WebSockets:** an (Standard). Ohne WebSockets gibt es keine Live-Aktualisierung.
- **SSL/TLS → Edge Certificates → Always Use HTTPS:** an.

### Testen

- `https://poker.<deine-domain>` zeigt „Raum beitreten“.
- `https://poker.<deine-domain>/admin/` zeigt **„Nicht gefunden“** – so soll es sein.
- Die Verwaltung im Heimnetz unter `http://<ZimaOS-IP>:8090/admin/` öffnen.

### Wie die Verwaltung geschützt ist

Wilkenpoker erkennt Anfragen über den Tunnel an dem Header `CF-Connecting-IP`, den Cloudflare immer setzt und den ein Angreifer nicht unterdrücken kann. Für solche Anfragen gibt es die Verwaltung nicht (Antwort 404). Direkt erreichbar ist sie nur aus den Netzen in `ADMIN_NETWORKS` – standardmäßig die privaten Netze (Heimnetz, Docker). Zusätzlich braucht es weiterhin das Passwort.

Über den Header ermittelt Wilkenpoker auch die echte Adresse der Teilnehmer. Die Sperren nach falschen Codes treffen deshalb nur den Verursacher und nicht alle, die über den Tunnel kommen.

### Optional: nur für Kolleginnen und Kollegen

Mit **Cloudflare Access** (Zero Trust → Access → Applications) lässt sich vor `poker.<deine-domain>` eine Anmeldung per E-Mail-Code schalten, z. B. nur für Adressen der Firmen-Domain. Wilkenpoker braucht dafür keine Änderung.
