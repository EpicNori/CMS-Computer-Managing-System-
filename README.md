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
- Remote-Input-Sperre im Controller, damit Klicks/Hotkeys/Text erst nach bewusstem Entsperren gesendet werden.
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
# Editiere CMS_ADMIN_TOKEN und CMS_ENROLLMENT_TOKEN in .env.
npm run dev
```

## Verbindung ueber andere Netzwerke

Der Coordinator lauscht standardmaessig auf `0.0.0.0:4377`, also auf allen Netzwerkinterfaces des Server-PCs. Auf anderen Geraeten muss `CMS_SERVER_URL` auf die erreichbare Adresse des Coordinator-PCs zeigen, zum Beispiel:

```powershell
$env:CMS_SERVER_URL="ws://192.168.178.50:4377/ws"
npm run dev:agent
```

Das gilt auch fuer einen Controller auf einem anderen PC:

```powershell
$env:CMS_SERVER_URL="ws://192.168.178.50:4377/ws"
npm run dev:controller
```

Fuer VPN, Cloud-Server oder Portweiterleitung nutze statt der LAN-IP die VPN-IP, oeffentliche IP oder Domain. Stelle sicher, dass Firewall/Router TCP-Port `4377` zum Coordinator durchlassen. Fuer Internet-Betrieb sollte davor ein TLS-Reverse-Proxy oder VPN genutzt werden und die URL dann als `wss://deine-domain/ws` gesetzt werden.

Damit ein PC aus einem anderen Internet/anderen Standort verbindet, muss der Coordinator von dort erreichbar sein:

- Am einfachsten: Coordinator auf einen VPS/Server stellen und Agents mit `wss://deine-domain/ws` verbinden.
- Alternativ: Portweiterleitung am Router auf den Coordinator-PC einrichten und Windows-Firewall fuer TCP `4377` freigeben.
- Sicherer fuer privat: VPN wie WireGuard/Tailscale nutzen und `CMS_SERVER_URL` auf die VPN-IP setzen.

Die Enrollment-BAT kann die externe Adresse direkt bekommen:

```powershell
scripts\enroll-agent.bat wss://deine-domain.example/ws dein-langer-cms-token "Office PC"
```

Fuer einen stillen Hintergrundstart gibt es zusaetzlich:

```powershell
scripts\enroll-agent-background.bat wss://deine-domain.example/ws dein-langer-cms-token "Display 01"
```

Die BATs sind nur noch kleine Wrapper um `scripts\run-agent.ps1`. Fuer Bootstrap/Download auf einem frischen Zielgeraet nutze `scripts\install-cms.ps1`; dieser Installer installiert bei Bedarf Node.js LTS ueber `winget`, kopiert oder laedt die Projektdateien, fuehrt `npm install` aus und startet danach den Agent. Falls `winget` auf dem System fehlt, muss Node.js LTS einmal manuell installiert werden.

Wenn `scripts\enroll-agent.bat`, `scripts\enroll-agent-background.bat`, `scripts\run-agent.ps1` oder `scripts\install-cms.ps1` fuer einen Agent alleine ohne restliches Projekt gestartet werden, legen sie eine schlanke Agent-Installation an. Dabei werden nur `apps\agent\index.js`, `scripts\run-agent.ps1`, `scripts\enroll-agent-background.bat` und ein minimales `package.json` mit den Agent-Abhaengigkeiten gespeichert. Controller, Server, Tests und Electron werden nicht heruntergeladen.
Die wichtigsten Standardwerte koennen als Parameter oder Umgebungsvariablen gesetzt werden.

Optional koennen Downloadquelle und Zielordner vorher gesetzt werden:

```powershell
$env:CMS_REPO_ZIP_URL="https://github.com/EpicNori/CMS-Computer-Managing-System-/archive/refs/heads/main.zip"
$env:CMS_INSTALL_DIR="$env:LOCALAPPDATA\CMS-Computer-Managing-System"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-cms.ps1 -Mode AgentVisible -ServerUrl wss://deine-domain.example/ws -EnrollmentToken dein-langer-cms-token -DeviceName "Office PC"
```

Fuer eine machine-weite Installation kann die BAT als Administrator mit `--install-global` gestartet werden:

```powershell
scripts\enroll-agent.bat --install-global wss://deine-domain.example/ws dein-langer-cms-token "Office PC"
```

Das legt einen sichtbaren geplanten Task `\CMS\CMS Visible Agent` an, der den Agent fuer jeden angemeldeten User startet. Das ist absichtlich kein klassischer Windows-Service: Services laufen in Session 0 und koennen den sichtbaren Desktop normalerweise nicht fuer Screen/Input erreichen.

Fuer 24/7-Display-PCs gibt es zusaetzlich einen Display-Modus:

```powershell
scripts\enroll-agent.bat --install-display wss://deine-domain.example/ws dein-langer-cms-token "Display 01"
```

Das legt `\CMS\CMS Display Agent` an, startet den Agent bei User-Logon versteckt im Hintergrund und haelt den Task wartend, damit Windows ihn bei einem Exit erneut starten kann. Logs landen standardmaessig in `%ProgramData%\CMS-Computer-Managing-System\logs\agent.log`. Der Modus ist fuer autorisierte Anzeige-/Kiosk-PCs gedacht.

Im globalen oder Display-Modus installiert die BAT Node.js LTS per `winget --scope machine`, wenn Node/npm fehlen. Dafuer ist ein Administrator-Terminal noetig.
Wenn `--install-global` oder `--install-display` aus einem temporaeren Ordner gestartet wird, kopiert die BAT die Projektdateien zuerst nach `%ProgramData%\CMS-Computer-Managing-System`, damit der geplante Task spaeter nicht von diesem temporaeren Pfad abhaengt.

Der Controller braucht seit dem Security-Hardening ebenfalls einen expliziten Admin-Token. Beim Installieren kann er direkt uebergeben werden:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-cms.ps1 -Mode Controller -ServerUrl ws://localhost:4377/ws -AdminToken dein-langer-cms-token
```

Der Installer schreibt die Runtime-Werte in `.env` im Installationsordner. Fuer lokale Demos mit den Beispiel-Tokens kann `-AllowInsecureDefaultTokens` genutzt werden; fuer echte Geraete sollte das nicht verwendet werden.

Optional kann der Server fuer Statusausgaben eine feste externe Adresse anzeigen:

```powershell
$env:CMS_PUBLIC_HOST="deine-domain.example"
npm run dev:server
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

## Windows Enrollment

Starte `scripts\install-cms.ps1` fuer Installation/Bootstrap oder nutze `scripts\enroll-agent.bat` und `scripts\enroll-agent-background.bat`, wenn das Projekt bereits vollstaendig auf dem Zielgeraet liegt.

Im Controller kann ueber `BAT Autostart` ein minimierter Shortcut zu `scripts\enroll-agent-background.bat` im Windows-Autostart-Ordner des angemeldeten Users angelegt werden.

## Flipper Zero Enrollment

Fuer autorisierte Windows-Geraete gibt es eine sichtbare BadUSB-Vorlage unter `scripts\flipper-agent-visible.txt`. Die Vorlage nutzt fuer lokale Demos standardmaessig `ws://localhost:4377/ws`, `change-this-cms-token` und `-AllowInsecureDefaultTokens`. Fuer echte Geraete muessen `SERVER_URL`, `ENROLLMENT_TOKEN` und optional `DEVICE_NAME` angepasst werden; entferne dann auch `-AllowInsecureDefaultTokens`. Die Vorlage oeffnet sichtbar PowerShell, zeigt eine kurze Warnung, wartet 5 Sekunden, laedt `install-cms.ps1` anonym herunter und startet den sichtbaren Agent autonom. Das ist fuer autorisierte Displays ohne Tastatur/Maus gedacht.

Anonyme Downloads funktionieren nicht direkt aus einem privaten GitHub-Raw-Repo. Die Vorlage nutzt deshalb zuerst die GitHub-Pages-URL `https://epicnori.github.io/CMS-Computer-Managing-System-/install-cms.ps1` und danach nur als Fallback den Raw-GitHub-Link. Die Workflow-Datei `.github/workflows/publish-installer-pages.yml` veroeffentlicht ausschliesslich `scripts\install-cms.ps1` nach GitHub Pages; der Rest des Repositorys kann privat bleiben, solange GitHub Pages fuer das Repository oeffentlich verfuegbar ist. Aktiviere dafuer in GitHub `Settings -> Pages -> Source: GitHub Actions` und starte den Workflow `Publish anonymous installer`.

Wenn der Download weiter mit `404: Not Found` fehlschlaegt, ist auch die Pages-URL noch nicht veroeffentlicht oder nicht oeffentlich erreichbar. Dann Workflow ausfuehren, Pages-Einstellungen pruefen oder eine andere oeffentliche HTTPS-URL in `INSTALLER_URLS` in `scripts\flipper-agent-visible.txt` eintragen.

Die Vorlage ist absichtlich nicht stealthy: kein UAC-Bypass, kein versteckter Start und keine Persistenz. Fuer globale Installation oder Display-/Hintergrundmodus nutze weiterhin `install-cms.ps1` manuell in einem Administrator-Terminal.

## Erlaubte Commands

Der Agent erlaubt aktuell nur diese Commands:

- `hostname`
- `whoami`
- `ipconfig`
- `systeminfo`
- `tasklist`
- `screen:snapshot` nur wenn `CMS_ALLOW_SCREEN_VIEW=1` gesetzt ist
- `startup:install` legt einen minimierten Windows-Autostart-Shortcut fuer `scripts\enroll-agent-background.bat` an
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
