# CLAUDE.md – Teampoker

Planning-Poker-Website für die wöchentlichen Refinements. Teams schätzen verdeckt die Komplexität eines Tickets, decken gemeinsam auf und besprechen, warum jemand höher oder niedriger geschätzt hat. Mehrere Teams nutzen je einen eigenen Raum.

## Kontext

- **Auftraggeber und einziger Admin:** Markus, Product Owner des ESM-Teams bei Wilken (Modul „ESM“ im System ENER:GY). Das Team hatte für die Refinements bisher kein Tool.
- **Name:** Das Projekt hieß ursprünglich **Wilkenpoker** und wurde in **Teampoker** umbenannt (PR #31). Repository `DrDanone/Teampoker` (privat, alte Adresse `DrDanone/Wilkenpoker` leitet weiter), Image `ghcr.io/drdanone/teampoker` (öffentlich).
- **Dokumente:** Konzept in `KONZEPT.md`, Arbeitspakete in den GitHub-Issues, Installation und Betrieb in `docs/ZIMAOS.md`.
- **Sprache** in Code-Kommentaren, Oberfläche, Commits, PRs, Issues und Antworten: **Deutsch**, knapp und sachlich. Ergebnisse zusammenfassen statt Arbeitsschritte aufzuzählen, PRs und Issues verlinken.

## Befehle

```bash
npm install
npm test          # node:test, alle Tests in test/**/*.test.js
npm run lint      # ESLint + Prettier (prüfen)
npm run format    # Prettier (korrigieren)
ADMIN_PASSWORD=ein-langes-passwort npm run dev   # http://localhost:3000, Verwaltung /admin/
```

Vor jedem Commit müssen `npm test` und `npm run lint` grün sein. Die CI (`.github/workflows/ci.yml`, `docker.yml`) führt bei jedem PR Lint, Tests, `npm audit` sowie Image-Build und Rauchtest (`scripts/docker-smoke.sh`) aus. Jeder Push auf `main` veröffentlicht das Image (`amd64` und `arm64`).

## Aufbau

| Pfad                      | Inhalt                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `server/index.js`         | Start: Konfiguration, Prüfung von `DATA_DIR`, Speicher laden                                                |
| `server/config.js`        | Einstellungen aus Umgebungsvariablen, Prüfung beim Start                                                    |
| `server/app.js`           | HTTP-Routing, Verwaltungs-Sperre, Logo-Auslieferung                                                         |
| `server/ws.js`            | WebSocket `/ws`: Origin-Prüfung, Limits, Heartbeat                                                          |
| `server/poker/`           | `hub.js` (Protokoll), `room-session.js` (Teilnehmer, Runde), `cards.js` (Kartenset, Auswertung), `names.js` |
| `server/rooms/`           | Raum-Codes und `RoomStore` (`rooms.json`, atomisch geschrieben)                                             |
| `server/admin/`           | Admin-API (`routes.js`), Sitzungen und zeitkonstanter Vergleich (`sessions.js`), CSRF                       |
| `server/branding/logo.js` | Logo-Prüfung und -Speicherung                                                                               |
| `server/network.js`       | `ADMIN_NETWORKS`, `TRUSTED_PROXIES`, echte Client-IP                                                        |
| `server/security.js`      | CSP und weitere Sicherheits-Header                                                                          |
| `public/`                 | Oberfläche ohne Build-Schritt; `theme.css` = GY-Utility-Tokens, `icons/` = Material Symbols                 |
| `public/admin/`           | Verwaltung (`index.html`, `admin.js`, `admin.css`)                                                          |
| `test/`                   | Tests; `helpers.js` startet einen Testserver, `ws-client.js` ist ein WebSocket-Testclient                   |
| `docs/ZIMAOS.md`          | Installation, Cloudflare Tunnel, Update, Sicherung, Fehlersuche                                             |

Node.js 22 (LTS), **kein Web-Framework**, einzige Laufzeit-Abhängigkeit ist `ws`. Frontend ist reines HTML/CSS/JS. Neue Abhängigkeiten nur mit guter Begründung.

## Einstellungen

| Variable          | Standard      | Bedeutung                                                                                             |
| ----------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`  | –             | Passwort des Superadmins, Pflicht, mind. 12 Zeichen. Ohne Passwort startet die App absichtlich nicht. |
| `PORT`            | `3000`        | Port im Container                                                                                     |
| `DATA_DIR`        | `./data`      | Räume und Logo; im Container `/data`                                                                  |
| `PUBLIC_URL`      | –             | Öffentliche Adresse für Einladungslinks aus der Verwaltung, z. B. `https://poker.<domain>`            |
| `ADMIN_NETWORKS`  | private Netze | Netze, aus denen `/admin/` direkt erreichbar ist; über Tunnel/Proxy nie. `*` = überall                |
| `TRUSTED_PROXIES` | private Netze | Proxys/Tunnel, deren `CF-Connecting-IP` bzw. `X-Forwarded-For` als Client-Adresse gilt                |

## Festgelegte Produktentscheidungen

Nicht ohne Rückfrage bei Markus ändern:

- **Keine Ticket-Informationen** in der App – nur Schätzen; das Ticket wird mündlich angesagt.
- **Superadmin** (Markus) verwaltet Räume (anlegen, umbenennen, löschen, Code neu erzeugen) und das Logo. Die Verwaltung `/admin/` ist **nur direkt im Heimnetz** erreichbar, über Tunnel/Proxy 404. Login mit `ADMIN_PASSWORD` (mind. 12 Zeichen). Einladungslinks aus der Verwaltung nutzen `PUBLIC_URL`.
- **Raum-Code:** 8 Zeichen, Großbuchstaben und Ziffern ohne 0/O/1/I/L, kryptografischer Zufall, Eingabe ohne Beachtung der Groß-/Kleinschreibung; Einladungslink `/join/CODE`. Neuer Code macht den alten sofort ungültig.
- **Teilnehmer** geben nur ihren Namen ein; Namen sind pro Raum eindeutig. Kein Zuschauer-Modus – wer aussetzt, nimmt die Kaffeekarte. Nach Neuladen kehrt man als dieselbe Person mit derselben Schätzung zurück; Offline-Teilnehmer werden ausgegraut und später entfernt.
- **Karten:** 0, ½, 1, 2, 3, 5, 8, 13, 20, 40, 100, ?, Kaffee – „?“ und Kaffee nicht in der Statistik.
- **Alle** dürfen aufdecken (nur per Klick, auch wenn noch nicht alle gewählt haben) und alle zurücksetzen; nach dem Aufdecken sind die Karten gesperrt. Vor dem Aufdecken sehen alle, **wer** gewählt hat, nicht **was**.
- **Ergebnis:** Namen mit Werten, Durchschnitt, Median, Spanne; **alle** mit höchstem bzw. niedrigstem Wert markiert; Hinweis bei Einigkeit.
- **Speicherung:** Schätzungen nur im Arbeitsspeicher; gespeichert werden nur Räume (`rooms.json`) und Logo in `/data`.
- **Design GY Utility** (Design System in Claude): Purple `#951b81`, Deep Blue `#081950`, Lilac `#c8aee3`, Violet `#7832de`, Magenta `#d71482`, Sand `#d9d6d1`; Schrift Aptos (Fallback Segoe UI/Helvetica/Arial); flächig, abgerundet, keine Schatten, keine Verläufe; Material Symbols Weight 200, nicht gefüllt, lokal ausgeliefert. Deutsch, keine Emojis. Logo links oben statt Purple-Kurve (ohne Logo bleibt die Kurve). Keine Rundennummer – neben „Deine Karte“ steht, wie viele schon gewählt haben. Keine Fußzeile „by Wilken“. Muss auf Laptop und Smartphone funktionieren.

## Sicherheitsregeln

Diese Eigenschaften sind durch Tests abgesichert und dürfen nicht aufgeweicht werden:

- Schätzwerte verlassen den Server **erst nach dem Aufdecken** (`RoomSession.stateFor`). Wiederkehr-Tokens nur an den Eigentümer.
- Frontend: Texte nur über `textContent`, nie `innerHTML`/`eval`. **Keine Inline-Skripte, -Styles oder `on…`-Attribute** (CSP). Nichts von fremden Servern laden (DSGVO).
- Jede WebSocket-Nachricht serverseitig validieren; Origin-Prüfung, Nachrichtengröße, Ratenlimit, Verbindungs- und Teilnehmerlimits bleiben.
- Admin-API: Cookie `HttpOnly`/`SameSite=Strict` (`Secure` hinter HTTPS), CSRF-Token, Origin-Prüfung, zeitkonstanter Passwortvergleich, Sperre nach Fehlversuchen, Ablauf nach Inaktivität.
- Logo: Format über Dateisignatur (PNG, JPG, WebP, SVG, max. 1 MB), gefährliche SVGs **ablehnen**, Auslieferung mit `nosniff` und CSP-`sandbox`.
- **Keine verschachtelten Regexe auf Benutzereingaben** (ReDoS – ist schon einmal passiert).
- Client-IP aus `CF-Connecting-IP`/`X-Forwarded-For` nur, wenn die Verbindung aus `TRUSTED_PROXIES` kommt.
- Verwaltungspfade werden roh, dekodiert **und normalisiert** geprüft (`/%61dmin/`, `/%2fadmin/`); zusätzlich sperrt die statische Auslieferung `public/admin/` selbst.
- Header: CSP, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer` (der Einladungslink enthält den Code).
- Keine Namen, Codes, Tokens oder Passwörter in Logs. Kein Tracking, keine externen Dienste.
- Container ohne root (UID 1000), schreibgeschützt bis auf `/data` (und `/tmp` als tmpfs), `cap_drop: ALL`, `no-new-privileges`, keine Geheimnisse im Image.

## Betrieb

- **Server:** Markus' ZimaOS-Server, Container `teampoker`, Port `8090:3000`, Daten `/DATA/AppData/teampoker` → `/data` (Ordner muss UID 1000 gehören).
- **Verwaltung:** `http://<server-ip>:8090/admin/`, nur im Heimnetz.
- **Zugriff für das Team:** über Markus' bestehenden Cloudflare Tunnel mit eigener Subdomain (`https://poker.<domain>`), HTTPS durch Cloudflare. Keine Portweiterleitung am Router; die ZimaOS-Oberfläche bleibt intern. Im Tunnel das Feld **HTTP Host Header leer lassen** (sonst scheitert die Origin-Prüfung), WebSockets müssen an sein.
- **Installation/Update:** über die ZimaOS-Oberfläche (Custom Install → Compose importieren) oder per SSH mit `docker compose`. Laufende Schätzrunden gehen bei einem Neustart verloren – nicht während eines Refinements aktualisieren.

## Arbeitsweise

- Ein Issue = ein Branch = ein Pull Request mit `Closes #…`. Claude darf Issues anlegen, Branches pushen und PRs öffnen.
- **Niemals selbst mergen** – nur, wenn Markus es ausdrücklich sagt. Markus macht die Code Reviews in separaten Claude-Sitzungen (meist gesammelt am Ende) und mergt selbst, per normalem Merge-Commit, nicht per Squash.
- Review-Sitzungen schreiben ihre Befunde als Kommentare direkt an die PRs auf GitHub; die umsetzende Sitzung antwortet direkt am jeweiligen Kommentar.
- Hängt ein Paket von ungemergten Änderungen ab: Branch auf den vorherigen aufsetzen, Basis des PRs entsprechend setzen und im PR vermerken. Spätere Änderungen per **Merge** in die folgenden Branches übernehmen – kein Rebase, kein Force-Push.
- Neue Funktionen bekommen Tests. Oberflächen-Änderungen im headless Chrome prüfen (Desktop und 390 px Breite) und mit axe-core auf Barrierefreiheit testen.
- Commits und PR-Beschreibungen auf Deutsch, mit Kontext und Hinweisen fürs Review.
- Bei echten Entscheidungen fragen; sonst sinnvoll entscheiden und im PR vermerken.

## Code Review

Für Reviews zusätzlich prüfen:

1. Bleiben alle Punkte unter **Sicherheitsregeln** erfüllt? Gibt es neue Eingaben ohne Prüfung?
2. Weicht etwas von den **Produktentscheidungen** ab?
3. Sind neue Verhaltensweisen durch Tests abgedeckt, und laufen `npm test` und `npm run lint`?
4. Bei Änderungen an `public/`: keine Inline-Skripte/-Styles, Texte über `textContent`, Barrierefreiheit (Kontrast, Tastatur, Fokus).
5. Bei Änderungen an Dockerfile/Compose: läuft weiter als UID 1000, read-only, kein Geheimnis im Image.

## Stolperstellen

- **`$` im Admin-Passwort:** Docker Compose deutet `$abc` in der Compose-Datei (auch beim Eintrag über die ZimaOS-Oberfläche) als Variable und ersetzt es durch einen leeren Text. Der Container startet trotzdem, der Login scheitert mit „Passwort falsch“. Abhilfe: ein Passwort ohne `$` (so macht es Markus) oder jedes `$` als `$$` schreiben. Der Login-Code selbst ist geprüft und funktioniert.
- Beim Schreiben von Dateien können Unicode-Escapes (z. B. `\u200b`, `\uFEFF`) als **echte unsichtbare Zeichen** landen. Solche Stellen über Zeichencodes erzeugen und danach prüfen:
  `LC_ALL=C.UTF-8 grep -rnP "[\x{2028}\x{2029}\x{200b}-\x{200f}\x{feff}]" server/ public/ test/`
- Dependabot schlägt auch Node-Versionen vor, die keine LTS sind (z. B. 25). Im Image bei der LTS-Linie bleiben (derzeit 22); Hauptversionen sind in `dependabot.yml` ausgeschlossen.
- In der Claude-Arbeitsumgebung:
  - Docker Hub ist nicht erreichbar – Images werden nur in der GitHub-CI gebaut und getestet.
  - GitHub GraphQL ist gesperrt; `gh api` mit REST-Endpunkten (`repos/DrDanone/Teampoker/...`) verwenden.
  - Schreibzugriffe auf GitHub (Issues, Push, PRs) muss Markus je Sitzung freigeben.
  - Headless Chrome liegt unter `/usr/bin/google-chrome`, Playwright unter `/opt/npm-tools/node_modules/playwright`.

## Stand (8. November 2026)

- Alle Arbeitspakete #1–#10 sind umgesetzt, reviewt und auf `main` gemergt; CI und Image-Veröffentlichung sind grün.
- Umbenennung in Teampoker ist gemergt (#31).
- Teampoker läuft auf ZimaOS und ist über den Cloudflare Tunnel mit gesetzter `PUBLIC_URL` von außen erreichbar; die Verwaltung nur im Heimnetz.
- Das Admin-Passwort enthält bewusst kein `$` (siehe Stolperstellen). Eine Variante „Passwort aus Datei“ (`ADMIN_PASSWORD_FILE`) wurde erwogen und von Markus als nicht nötig verworfen.
- Dependabot-PRs #23–#29 sind erledigt (#28 mit Node 25 abgelehnt, dafür #30: Node-Hauptversionen werden ignoriert).
