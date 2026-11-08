# CLAUDE.md – Teampoker

Planning-Poker-Website für die wöchentlichen Refinements von Markus (Product Owner des ESM-Teams bei Wilken). Teams schätzen verdeckt die Komplexität eines Tickets, decken gemeinsam auf und diskutieren Ausreißer. Mehrere Teams nutzen je einen eigenen Raum.

- Konzept: `KONZEPT.md`; Arbeitspakete: GitHub-Issues.
- Betrieb: Docker-Container auf Markus' ZimaOS-Server, Image `ghcr.io/drdanone/teampoker` (öffentlich), Zugriff über Markus' Cloudflare Tunnel. Anleitung: `docs/ZIMAOS.md`.
- Sprache in Code-Kommentaren, Oberfläche, Commits, PRs und Antworten: **Deutsch**.

## Befehle

```bash
npm install
npm test          # node:test, alle Tests in test/**/*.test.js
npm run lint      # ESLint + Prettier (prüfen)
npm run format    # Prettier (korrigieren)
ADMIN_PASSWORD=ein-langes-passwort npm run dev   # http://localhost:3000, Verwaltung /admin/
```

Vor jedem Commit müssen `npm test` und `npm run lint` grün sein. Die CI führt zusätzlich `npm audit` sowie Image-Build und Rauchtest (`scripts/docker-smoke.sh`) aus.

## Aufbau

| Pfad                      | Inhalt                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `server/index.js`         | Start: Konfiguration, Prüfung von `DATA_DIR`, Speicher laden                                                |
| `server/app.js`           | HTTP-Routing, Verwaltungs-Sperre, Logo-Auslieferung                                                         |
| `server/ws.js`            | WebSocket `/ws`: Origin-Prüfung, Limits, Heartbeat                                                          |
| `server/poker/`           | `hub.js` (Protokoll), `room-session.js` (Teilnehmer, Runde), `cards.js` (Kartenset, Auswertung), `names.js` |
| `server/rooms/`           | Raum-Codes und `RoomStore` (`rooms.json`, atomisch geschrieben)                                             |
| `server/admin/`           | Admin-API, Sitzungen, CSRF                                                                                  |
| `server/branding/logo.js` | Logo-Prüfung und -Speicherung                                                                               |
| `server/network.js`       | `ADMIN_NETWORKS`, `TRUSTED_PROXIES`, echte Client-IP                                                        |
| `server/security.js`      | CSP und weitere Sicherheits-Header                                                                          |
| `public/`                 | Oberfläche ohne Build-Schritt; `theme.css` = GY-Utility-Tokens, `icons/` = Material Symbols                 |
| `test/`                   | Tests; `helpers.js` startet einen Testserver, `ws-client.js` ist ein WebSocket-Testclient                   |

Node.js 22, **kein Web-Framework**, einzige Laufzeit-Abhängigkeit ist `ws`. Neue Abhängigkeiten nur mit guter Begründung.

## Festgelegte Produktentscheidungen

Nicht ohne Rückfrage bei Markus ändern:

- **Keine Ticket-Informationen** in der App – nur Schätzen.
- **Superadmin** verwaltet Räume (anlegen, umbenennen, löschen, Code neu erzeugen) und das Logo. Die Verwaltung `/admin/` ist **nur direkt im Heimnetz** erreichbar, über Tunnel/Proxy 404. Login mit `ADMIN_PASSWORD` (mind. 12 Zeichen).
- **Raum-Code:** 8 Zeichen, Großbuchstaben und Ziffern ohne 0/O/1/I/L; Einladungslink `/join/CODE`.
- **Teilnehmer** geben nur ihren Namen ein; Namen sind pro Raum eindeutig. Kein Zuschauer-Modus.
- **Karten:** 0, ½, 1, 2, 3, 5, 8, 13, 20, 40, 100, ?, Kaffee – „?“ und Kaffee nicht in der Statistik.
- **Alle** dürfen aufdecken (nur per Klick) und alle zurücksetzen; nach dem Aufdecken sind die Karten gesperrt.
- **Ergebnis:** Namen mit Werten, Durchschnitt, Median, Spanne; **alle** mit höchstem bzw. niedrigstem Wert markiert; Hinweis bei Einigkeit.
- **Speicherung:** Schätzungen nur im Arbeitsspeicher; gespeichert werden nur Räume und Logo in `/data`.
- **Design GY Utility:** Purple `#951b81`, Deep Blue `#081950`, Lilac, Violet, Magenta; Aptos; flächig, abgerundet, keine Schatten; Material Symbols Weight 200 lokal; Deutsch, keine Emojis. Logo links oben statt Purple-Kurve. Keine Rundennummer, keine Fußzeile „by Wilken“.

## Sicherheitsregeln

Diese Eigenschaften sind durch Tests abgesichert und dürfen nicht aufgeweicht werden:

- Schätzwerte verlassen den Server **erst nach dem Aufdecken** (`RoomSession.stateFor`). Wiederkehr-Tokens nur an den Eigentümer.
- Frontend: Texte nur über `textContent`, nie `innerHTML`/`eval`. **Keine Inline-Skripte, -Styles oder `on…`-Attribute** (CSP). Nichts von fremden Servern laden.
- Jede WebSocket-Nachricht serverseitig validieren; Origin-Prüfung, Nachrichtengröße, Ratenlimit, Verbindungslimits bleiben.
- Admin-API: Cookie `HttpOnly`/`SameSite=Strict`, CSRF-Token, Origin-Prüfung, Sperre nach Fehlversuchen.
- Logo: Format über Dateisignatur, gefährliche SVGs **ablehnen**, Auslieferung mit CSP-`sandbox`.
- **Keine verschachtelten Regexe auf Benutzereingaben** (ReDoS – ist schon einmal passiert).
- Client-IP aus `CF-Connecting-IP`/`X-Forwarded-For` nur, wenn die Verbindung aus `TRUSTED_PROXIES` kommt.
- Verwaltungspfade werden dekodiert **und normalisiert** geprüft (`/%61dmin/`, `/%2fadmin/`); zusätzlich sperrt die statische Auslieferung `public/admin/` selbst.
- Keine Namen, Codes, Tokens oder Passwörter in Logs.
- Container ohne root, schreibgeschützt bis auf `/data`.

## Arbeitsweise

- Ein Issue = ein Branch = ein Pull Request mit `Closes #…`.
- **Niemals selbst mergen.** Markus macht die Code Reviews in separaten Sitzungen und mergt selbst.
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

- Beim Schreiben von Dateien können Unicode-Escapes (z. B. `\u200b`, `\uFEFF`) als **echte unsichtbare Zeichen** landen. Solche Stellen über Zeichencodes erzeugen und danach prüfen:
  `LC_ALL=C.UTF-8 grep -rnP "[\x{2028}\x{2029}\x{200b}-\x{200f}\x{feff}]" server/ public/ test/`
- Docker Hub ist aus der Claude-Arbeitsumgebung nicht erreichbar – Images werden nur in der GitHub-CI gebaut und getestet.
- GitHub GraphQL ist dort gesperrt; `gh api` mit REST-Endpunkten verwenden.
