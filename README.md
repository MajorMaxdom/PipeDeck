# PipeDeck

A browser-based audio mixer for **PipeWire / PulseAudio** on Linux.  
Control volumes, routing, and virtual sinks from any device on your local network — desktop, tablet, or phone.

![PipeDeck Interface](https://raw.githubusercontent.com/MajorMaxdom/PipeDeck/refs/heads/main/pipedeck.png)
---

## Features

- Real-time VU meters for all hardware inputs, outputs, and application streams
- Per-channel volume faders and mute buttons
- Route hardware inputs to virtual sinks via loopback modules
- Create and delete virtual sinks (software mixer busses)
- Move application audio streams to any output
- Soundboard — play sound files directly to any output device
- Media player controls (via `playerctl`)
- Resizable panels, adjustable zoom, hide/show devices
- All settings and layout (volumes, routing, panel widths, hidden devices) **persist across restarts** in `settings.json`
- Runs as a systemd user service — starts automatically at login

---

## Disclaimer
This tool was completely vibe coded with Claude Code within 48 hours.
I needed a working Voicemeeter-Replacement, as I switched from Windows to Ubuntu.
As long as my Claude Code subscription is running, I'll try to let it update and fix anything that shows up.
If something doesn't work, I am more than happy to accept any pull requests.

---

## Prerequisites

### Audio system
PipeDeck requires **PipeWire** with the PulseAudio compatibility layer, or a native **PulseAudio** installation.

```bash
# Ubuntu / Debian — PipeWire (recommended, default since Ubuntu 22.10)
sudo apt install pipewire pipewire-pulse wireplumber

# Or plain PulseAudio
sudo apt install pulseaudio
```

### System tools

| Tool | Package | Purpose |
|------|---------|---------|
| `pactl` | `pulseaudio-utils` | Audio control |
| `parec` | `pulseaudio-utils` | Peak metering |
| `mpv` | `mpv` | Soundboard playback |
| `playerctl` | `playerctl` | Media player controls |

```bash
sudo apt install pulseaudio-utils mpv playerctl
```

### Python

Python **3.10 or newer** is required.

```bash
python3 --version   # must be 3.10+
```

Install the `websockets` library:

```bash
# System package (Ubuntu / Debian)
sudo apt install python3-websockets

# Or via pip
pip3 install websockets
```

---

## Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/pipedeck.git
   cd pipedeck
   ```

2. **Create the sounds folder** (optional, for the soundboard)
   ```bash
   mkdir -p sounds
   # Drop .mp3 / .wav / .ogg / .flac files into sounds/ to use them
   ```

3. **Run manually** to verify everything works
   ```bash
   python3 server.py
   # → PipeDeck started
   # →   Local:   http://localhost:8080
   # →   Network: http://192.168.x.x:8080
   ```
   Open the printed URL in your browser.

---

## Auto-start at login (systemd user service)

A systemd user service starts PipeDeck automatically whenever you log in — no root required.

### Install the service

1. Create the systemd user directory:
   ```bash
   mkdir -p ~/.config/systemd/user
   ```

2. Create the service file at `~/.config/systemd/user/pipedeck.service`:
   ```ini
   [Unit]
   Description=PipeDeck – browser-based PipeWire/PulseAudio mixer
   After=pipewire.service pipewire-pulse.service
   Wants=pipewire.service pipewire-pulse.service

   [Service]
   Type=simple
   WorkingDirectory=/path/to/pipedeck
   ExecStart=/usr/bin/python3 /path/to/pipedeck/server.py
   Restart=on-failure
   RestartSec=5
   StandardOutput=journal
   StandardError=journal
   Environment=PYTHONUNBUFFERED=1

   [Install]
   WantedBy=default.target
   ```
   Replace `/path/to/pipedeck` with the actual path (e.g. `/home/yourname/pipedeck`).

3. Enable and start the service:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable pipedeck.service
   systemctl --user start pipedeck.service
   ```

4. Check that it is running:
   ```bash
   systemctl --user status pipedeck.service
   ```

### Useful service commands

```bash
systemctl --user stop    pipedeck.service   # stop
systemctl --user restart pipedeck.service   # restart
systemctl --user disable pipedeck.service   # remove from auto-start
journalctl --user -u pipedeck.service -f    # live logs
```

---

## Configuration

### Ports

The default ports can be changed via environment variables:

```bash
HTTP_PORT=9090 WS_PORT=9091 python3 server.py
```

Or in the systemd service file:

```ini
[Service]
Environment=HTTP_PORT=9090
Environment=WS_PORT=9091
```

### Persistent state

All settings are stored in two JSON files next to `server.py`:

| File | Contents |
|------|---------|
| `settings.json` | UI layout (panel widths, zoom, colors), hidden devices, source routing |
| `virtual_sinks.json` | Virtual sink definitions (created via the Settings panel) |

These files are created automatically. You can delete them to reset all settings to defaults.

---

## Accessing from other devices

PipeDeck binds to `0.0.0.0`, so it is reachable from any device on your local network:

```
http://192.168.x.x:8080
```

Your server's IP address is printed in the terminal / journal when PipeDeck starts. For permanent access from a tablet or phone, bookmark that URL or use your browser's "Add to Home Screen" option — PipeDeck is a PWA and will open full-screen.

> **Security note:** PipeDeck has no authentication. Only run it on a trusted local network.

---

## Project structure

```
pipedeck/
├── server.py            # Python backend (WebSocket + HTTP server)
├── settings.json        # Persisted UI and routing settings (auto-created)
├── virtual_sinks.json   # Persisted virtual sink config (auto-created)
├── sounds/              # Drop audio files here for the soundboard
└── public/
    ├── index.html
    ├── app.js
    ├── style.css
    └── manifest.json    # PWA manifest
```

---

## Dependencies summary

| Dependency | Type | Install |
|------------|------|---------|
| Python ≥ 3.10 | Runtime | System |
| `websockets` ≥ 13 | Python library | `apt install python3-websockets` |
| `pactl` / `parec` | System tool | `apt install pulseaudio-utils` |
| `mpv` | System tool | `apt install mpv` |
| `playerctl` | System tool | `apt install playerctl` |
| PipeWire + PulseAudio compat **or** PulseAudio | Audio system | `apt install pipewire pipewire-pulse wireplumber` |

---

## License

MIT
