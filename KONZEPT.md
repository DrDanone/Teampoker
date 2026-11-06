# Wilkenpoker – Konzept

Planning-Poker-Website für die wöchentlichen Refinements. Teams schätzen verdeckt die Komplexität eines Tickets, decken gemeinsam auf und diskutieren die Ausreißer.

## Grundprinzipien

- **Keine Ticket-Informationen.** Es wird ausschließlich geschätzt; welches Ticket dran ist, wird mündlich angesagt.
- **Minimale Anmeldung.** Teammitglieder geben nur den Raum-Code und ihren Namen ein.
- **Schätzungen sind flüchtig.** Sie liegen nur im Arbeitsspeicher und sind nach dem Refinement bzw. einem Neustart weg.

## Rollen

| Rolle | Zugang | Rechte |
|---|---|---|
| Superadmin (Markus) | `/admin`, Passwort aus Umgebungsvariable `ADMIN_PASSWORD` | Räume anlegen, umbenennen, löschen; Raum-Code neu erzeugen; Logo hochladen |
| Teilnehmer | Raum-Code + Name | Schätzen, aufdecken, alle Schätzungen zurücksetzen |

Alle Teilnehmer eines Raums sind gleichberechtigt. Es gibt keinen Zuschauer-Modus – jeder schätzt mit; wer nicht schätzen will, nimmt die Kaffeetasse.

## Räume und Codes

- Ein Raum pro Team, angelegt vom Superadmin.
- Jeder Raum hat einen zufälligen **8-stelligen Code** aus Großbuchstaben und Ziffern, ohne verwechselbare Zeichen (kein 0/O, 1/I/L). Eingabe unabhängig von Groß-/Kleinschreibung.
- Der Code ist der „Login“. Zusätzlich gibt es einen Einladungslink, der den Code enthält (`/join/ABCD2345`).
- Code neu erzeugen macht den alten sofort ungültig.
- Schutz gegen Durchprobieren: Sperre nach zu vielen Fehlversuchen pro IP.
- Räume (Name, Code) werden in einer kleinen Datei auf einem Docker-Volume gespeichert und überleben Neustarts. Schätzungen nicht.

## Ablauf einer Schätzrunde

1. Teilnehmer treten mit Code und Namen bei. Der Browser merkt sich den Namen.
2. Jeder wählt verdeckt eine Karte. Alle sehen, **wer** schon gewählt hat, nicht **was**. Bis zum Aufdecken kann die Karte geändert werden.
3. Jemand klickt **Aufdecken** – auch wenn noch nicht alle gewählt haben.
4. Ergebnis: alle Karten mit Namen, dazu Durchschnitt, Median und Spanne. Höchster und niedrigster Wert werden markiert, damit diese Personen ihre Sicht erklären können. Bei kompletter Einigkeit erscheint ein deutlicher Hinweis.
5. Nach dem Aufdecken sind die Karten gesperrt.
6. **Alle zurücksetzen** löscht alle Schätzungen für das nächste Ticket; die Teilnehmer bleiben im Raum.

### Kartenset

`0, ½, 1, 2, 3, 5, 8, 13, 20, 40, 100, ?, ☕`

„?“ und „☕“ fließen nicht in die Statistik ein.

## Teilnehmer und Verbindungen

- Namen sind pro Raum eindeutig.
- Nach Neuladen oder kurzem Verbindungsabbruch kehrt man als dieselbe Person mit derselben Schätzung zurück (Sitzungs-Token im Browser).
- Wer offline ist, wird ausgegraut und nach einiger Zeit entfernt.

## Design

Corporate Design **GY Utility** (Design System in Claude):

- Farben: Purple `#951b81` (Marke), Deep Blue `#081950`, Lilac `#c8aee3`, Violet `#7832de`, Magenta `#d71482`, Sand `#d9d6d1`.
- Schrift: Aptos, Fallback Segoe UI / Helvetica / Arial.
- Flächige Formen mit abgerundeten Ecken, keine Schatten, keine Verläufe.
- Icons: Google Material Symbols, Weight 200, nicht gefüllt.
- Sprache Deutsch, keine Emojis in der Oberfläche; die Kaffeetassen-Karte nutzt das Material-Symbols-Icon.
- Funktioniert auf Laptop und Smartphone.
- **Logo:** lädt der Superadmin im Admin-Bereich hoch (PNG, JPG, WebP oder SVG, max. 1 MB); es erscheint oben rechts. Ohne Logo steht dort der Schriftzug „Wilkenpoker“.
- Schriften und Icons werden lokal ausgeliefert, nicht von Google-Servern geladen (DSGVO).

## Sicherheit

- **HTTPS**, sobald der Zugriff über das Heimnetz hinausgeht (über Tunnel oder Reverse Proxy). Ohne HTTPS gehen Admin-Passwort und Raum-Codes im Klartext übers Netz.
- **Admin-Login:** starkes Passwort aus Umgebungsvariable, zeitkonstanter Vergleich, Sperre nach Fehlversuchen, Session-Cookie `HttpOnly`, `SameSite=Strict`, `Secure` (hinter HTTPS), Ablauf nach Inaktivität.
- **Raum-Codes** mit kryptografischem Zufall; Sperre nach zu vielen Fehlversuchen.
- **Logo-Upload** ist die größte Angriffsfläche: Dateityp über die Dateisignatur prüfen, SVG bereinigen (Skripte, Event-Handler, externe Verweise entfernen), eigener Dateiname, Auslieferung mit `X-Content-Type-Options: nosniff` und restriktiver CSP.
- **Eingaben:** Namen auf Länge und Zeichen prüfen, nie als HTML ausgeben (Schutz vor XSS). Jede WebSocket-Nachricht serverseitig validieren.
- **WebSocket:** Origin-Prüfung, Größen- und Ratenlimit pro Verbindung, maximale Teilnehmerzahl pro Raum.
- **HTTP-Header:** Content-Security-Policy, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer` (der Einladungslink enthält den Code).
- **Container:** schlankes Basis-Image, läuft nicht als root, Dateisystem schreibgeschützt bis auf `/data`, keine Geheimnisse im Image.
- **Abhängigkeiten:** möglichst wenige; `npm audit` in der CI, Dependabot für Updates.
- **Datenschutz:** Namen nur im Arbeitsspeicher, nicht in Logs; kein Tracking, keine externen Dienste.
- **Betrieb:** keine Portweiterleitung am Router; die ZimaOS-Oberfläche bleibt intern.

## Arbeitsweise

- Jedes Arbeitspaket ist ein GitHub-Issue.
- Pro Arbeitspaket ein eigener Branch und ein Pull Request, der das Issue referenziert.
- Gemergt wird erst nach Code Review. Markus macht die Reviews in separaten Claude-Sitzungen und mergt selbst.

## Technik

- **Backend:** Node.js, WebSockets für Live-Updates.
- **Frontend:** schlanke Web-Oberfläche ohne schweres Framework.
- **Persistenz:** eine JSON-Datei für Räume auf einem Volume.
- **Betrieb:** ein Docker-Container plus `docker-compose.yml` für ZimaOS.
  - Umgebungsvariablen: `ADMIN_PASSWORD`, `PORT`.
  - Volume: `/data`.

## Umsetzung in Schritten

1. App lokal bauen und testen.
2. Dockerfile und Compose-Datei; Installation auf ZimaOS.
3. Zugriff von außen entscheiden (Heimnetz, VPN oder Tunnel) und einrichten.

## Offene Punkte

- Zugriff für die Entwickler (Heimnetz / VPN / Tunnel) – wird nach Schritt 2 geklärt.
