# Computer Managing System

Ein sichtbares Remote-Operations-System fuer eigene und autorisierte Windows-/Server-Geraete.

## Kernfunktionen

- Zentraler Coordinator-Server mit WebSocket-Verbindungen.
- Sichtbarer Agent, der nur mit Enrollment-Token verbunden wird.
- Professioneller Electron-Controller mit Geraeteliste, Live-Session, Terminalausgabe und Audit.
- Live Screen Feed ueber eine explizit gestartete Stream-Session.
- PowerShell Command Runner, wenn der sichtbare Agent Shell-Zugriff erlaubt.
- Schnellaktionen fuer Name, User, Netzwerk, System, Prozesse und opt-in Screen Snapshot.
- Remote Input mit Screen-Klicks, Mausbuttons, Scrollen, Text und Hotkeys, wenn der sichtbare Agent es erlaubt.
- Autostart-Schnellaktion, die die sichtbare Enrollment-BAT als normalen Windows-Startup-Shortcut registriert.
- Audit-Log im Serverprozess.
- Bewusst begrenzte Command-Allowlist als Startpunkt.

## Was bewusst nicht eingebaut ist

- Keine versteckte Installation.
- Keine Persistenz ohne Zustimmung.
- Keine freie Remote-Shell als Default.
- Kein heimliches Screen-Capture.

Diese Grenzen sind Absicht: Das Tool soll fuer eigene Server und autorisierte Geraete nutzbar sein, nicht als RAT.

## Start

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

In einem zweiten Terminal kannst du lokal einen Test-Agent starten:

```powershell
npm run dev:agent
```

Wenn du im Controller den Screen-Button testen willst, muss der sichtbare Agent das ausdruecklich erlauben:

```powershell
$env:CMS_ALLOW_SCREEN_VIEW="1"
npm run dev:agent
```

Fuer Live-Ansicht und Remote-Steuerung muessen die entsprechenden Flags gesetzt werden:

```powershell
$env:CMS_ALLOW_SCREEN_VIEW="1"
$env:CMS_ALLOW_REMOTE_CONTROL="1"
npm run dev:agent
```

Fuer PowerShell Commands muss Shell-Zugriff zusaetzlich freigeschaltet werden:

```powershell
$env:CMS_ALLOW_SCREEN_VIEW="1"
$env:CMS_ALLOW_REMOTE_CONTROL="1"
$env:CMS_ALLOW_SHELL="1"
npm run dev:agent
```

## Windows Enrollment per BAT

Passe in `scripts\enroll-agent.bat` die Werte `CMS_SERVER_URL`, `CMS_ENROLLMENT_TOKEN` und `CMS_DEVICE_NAME` an und fuehre die Datei auf dem Zielgeraet sichtbar als Admin/User aus.

Im Controller kann ueber `BAT Autostart` ein normaler Shortcut zu `scripts\enroll-agent.bat` im Windows-Autostart-Ordner des angemeldeten Users angelegt werden.

## Erlaubte Commands

Der Agent erlaubt aktuell nur diese Commands:

- `hostname`
- `whoami`
- `ipconfig`
- `systeminfo`
- `tasklist`
- `screen:snapshot` nur wenn `CMS_ALLOW_SCREEN_VIEW=1` gesetzt ist
- `startup:install` legt einen sichtbaren Windows-Autostart-Shortcut fuer `scripts\enroll-agent.bat` an
- `input:*` nur wenn `CMS_ALLOW_REMOTE_CONTROL=1` gesetzt ist
- `shell:run` nur wenn `CMS_ALLOW_SHELL=1` gesetzt ist

Weitere Commands sollten spaeter pro Organisation/Rolle freigegeben und auditiert werden.

## Naechste sinnvolle Schritte

- TLS/mTLS oder WireGuard/VPN fuer echte Server-Umgebungen.
- Benutzerkonten, Organisationen, Rollen und Rechte.
- Persistente Datenbank statt In-Memory State.
- Signierter Agent-Installer.
- Consent-basierte Screen-Ansicht mit sichtbarem Indicator.
- Session-Aufzeichnung, Dateitransfer und Rollenfreigaben pro Geraetegruppe.
