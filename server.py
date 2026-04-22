#!/usr/bin/env python3
"""PipeDeck — browser-based PipeWire/PulseAudio mixer backend."""
import asyncio
import json
import os
import re
import struct
import subprocess
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

from websockets.asyncio.server import serve

CLIENTS: set = set()
PUBLIC_DIR = Path(__file__).parent / "public"
HTTP_PORT = int(os.environ.get("HTTP_PORT", 8080))
WS_PORT   = int(os.environ.get("WS_PORT",   8765))
ENV_C = {**os.environ, "LANG": "C", "LC_ALL": "C"}

PEAK_RATE  = 8000   # Hz — enough for level detection, low CPU
PEAK_CHUNK = PEAK_RATE * 2 // 10   # 100 ms of s16le mono = 1600 bytes

SOUNDS_DIR       = Path(__file__).parent / "sounds"
VIRTUAL_CFG_FILE = Path(__file__).parent / "virtual_sinks.json"
SETTINGS_FILE    = Path(__file__).parent / "settings.json"
SOUNDS_DIR.mkdir(exist_ok=True)

_sound_proc: asyncio.subprocess.Process | None = None

# List of dicts: {display_name, sink_name, loopback_sink, null_mod?, loopback_mod?}
_virtual_config: list[dict] = []
# source_name -> {mod_id, sink_name}
_source_routes: dict[str, dict] = {}
# Persisted settings: hidden_devices, source_routes, ui (zoom, panel_widths, etc.)
_settings: dict = {"hidden_devices": [], "source_routes": {}, "ui": {}}


# ---------------------------------------------------------------------------
# pactl parsing helpers
# ---------------------------------------------------------------------------

def run_pactl(*args) -> str:
    try:
        r = subprocess.run(
            ["pactl", *args], capture_output=True, text=True, env=ENV_C, timeout=5
        )
        return r.stdout
    except Exception:
        return ""


def parse_blocks(output: str, keyword: str) -> list[dict]:
    items = []
    pat = re.compile(rf"^{re.escape(keyword)}\s+#(\d+)", re.MULTILINE)
    positions = [(m.start(), int(m.group(1))) for m in pat.finditer(output)]

    for i, (start, index) in enumerate(positions):
        end = positions[i + 1][0] if i + 1 < len(positions) else len(output)
        block = output[start:end]

        def find(rx, default=None):
            m = re.search(rx, block, re.MULTILINE)
            return m.group(1).strip() if m else default

        item: dict = {"index": index}
        item["name"]        = find(r"^\s+Name:\s+(.+)")
        item["description"] = find(r"^\s+Description:\s+(.+)")
        state = find(r"^\s+State:\s+(\w+)")
        if state:
            item["state"] = state
        item["mute"]   = find(r"^\s+Mute:\s+(\w+)") == "yes"
        vol            = find(r"Volume:.*?(\d+)%")
        item["volume"] = int(vol) if vol else 100
        mon_src  = find(r"^\s+Monitor Source:\s+(.+)")
        if mon_src:
            item["monitorSource"] = mon_src
        mon_sink = find(r"^\s+Monitor of Sink:\s+(.+)")
        if mon_sink:
            item["monitorOfSink"] = mon_sink
        item["appName"]   = find(r'application\.name\s*=\s*"([^"]+)"')
        item["appIcon"]   = find(r'application\.icon_name\s*=\s*"([^"]+)"')
        item["mediaName"] = find(r'media\.name\s*=\s*"([^"]+)"')
        item["corked"]    = find(r"^\s+Corked:\s+(\w+)") == "yes"
        sink_idx = find(r"^\s+Sink:\s+(\d+)")
        if sink_idx:
            item["sink"] = int(sink_idx)
        items.append(item)
    return items


# ---------------------------------------------------------------------------
# Sounds
# ---------------------------------------------------------------------------

def get_sounds() -> list[str]:
    exts = {'.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'}
    try:
        return sorted(f.name for f in SOUNDS_DIR.iterdir() if f.suffix.lower() in exts)
    except Exception:
        return []


async def _play_sound(path: str, sink_name: str):
    global _sound_proc
    if _sound_proc and _sound_proc.returncode is None:
        try:
            _sound_proc.kill()
        except Exception:
            pass
    cmd = ["mpv", "--no-video", "--ao=pulse", "--really-quiet"]
    if sink_name:
        cmd += [f"--audio-device=pulse/{sink_name}"]
    cmd.append(path)
    try:
        _sound_proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            env=ENV_C,
        )
        await _sound_proc.wait()
    except Exception as e:
        print(f"[sound] {e}")


# ---------------------------------------------------------------------------
# Media info
# ---------------------------------------------------------------------------

def get_media_info() -> dict:
    try:
        r = subprocess.run(
            ["playerctl", "-a", "metadata", "--format",
             "{{playerName}}\t{{title}}\t{{artist}}\t{{status}}"],
            capture_output=True, text=True, timeout=3, env=ENV_C,
        )
        if r.returncode == 0 and r.stdout.strip():
            best = None
            for line in r.stdout.strip().splitlines():
                parts = line.split("\t")
                if len(parts) < 4:
                    continue
                entry = {"player": parts[0], "title": parts[1],
                         "artist": parts[2], "status": parts[3]}
                if entry["status"] == "Playing":
                    return entry
                if best is None:
                    best = entry
            if best:
                return best
    except Exception:
        pass
    return {"player": "", "title": "", "artist": "", "status": "Stopped"}


# ---------------------------------------------------------------------------
# Virtual sinks
# ---------------------------------------------------------------------------

def _load_settings():
    global _settings
    try:
        if SETTINGS_FILE.exists():
            loaded = json.loads(SETTINGS_FILE.read_text())
            _settings.update(loaded)
    except Exception:
        pass


def _save_settings():
    try:
        SETTINGS_FILE.write_text(json.dumps(_settings, indent=2))
    except Exception:
        pass


def _restore_source_routes():
    """Re-establish saved source→sink loopbacks after server restart."""
    saved = _settings.get("source_routes", {})
    for src_name, sink_name in saved.items():
        if not src_name or not sink_name:
            continue
        r = subprocess.run(
            ["pactl", "load-module", "module-loopback",
             f"source={src_name}", f"sink={sink_name}",
             "latency_msec=50"],
            capture_output=True, text=True, env=ENV_C, timeout=5,
        )
        if r.returncode == 0:
            _source_routes[src_name] = {
                "mod_id": int(r.stdout.strip()),
                "sink_name": sink_name,
            }
        else:
            print(f"[routes] restore {src_name} → {sink_name}: {r.stderr.strip()}")


def _load_virtual_cfg():
    global _virtual_config
    try:
        if VIRTUAL_CFG_FILE.exists():
            _virtual_config = json.loads(VIRTUAL_CFG_FILE.read_text())
    except Exception:
        _virtual_config = []


def _save_virtual_cfg():
    try:
        VIRTUAL_CFG_FILE.write_text(json.dumps(_virtual_config, indent=2))
    except Exception:
        pass


def _apply_virtual_sink(entry: dict) -> bool:
    """Load null-sink + optional loopback modules. Writes module IDs into entry."""
    sink_name = entry["sink_name"]
    display   = re.sub(r'["\\\n\r]', '', entry["display_name"])
    loopback  = entry.get("loopback_sink", "")

    r = subprocess.run(
        ["pactl", "load-module", "module-null-sink",
         f"sink_name={sink_name}",
         f'sink_properties=device.description="{display} (Virtual)"'],
        capture_output=True, text=True, env=ENV_C, timeout=5,
    )
    if r.returncode != 0:
        print(f"[virtual] create {sink_name}: {r.stderr.strip()}")
        entry["null_mod"] = None
        return False
    entry["null_mod"] = int(r.stdout.strip())

    entry["loopback_mod"] = None
    if loopback:
        r2 = subprocess.run(
            ["pactl", "load-module", "module-loopback",
             f"source={sink_name}.monitor", f"sink={loopback}",
             "latency_msec=50"],
            capture_output=True, text=True, env=ENV_C, timeout=5,
        )
        if r2.returncode == 0:
            entry["loopback_mod"] = int(r2.stdout.strip())
        else:
            print(f"[virtual] loopback to {loopback}: {r2.stderr.strip()}")
    return True


def _restore_virtual_sinks():
    for entry in _virtual_config:
        # Unload stale module IDs from a previous session (ignore errors)
        for key in ("loopback_mod", "null_mod"):
            mid = entry.get(key)
            if mid is not None:
                subprocess.run(["pactl", "unload-module", str(mid)],
                               check=False, capture_output=True, env=ENV_C)
        _apply_virtual_sink(entry)
    _save_virtual_cfg()


def _new_virtual_sink(display_name: str, loopback_sink: str) -> dict | None:
    safe = re.sub(r'[^a-zA-Z0-9]', '_', display_name).strip('_') or 'virtual'
    base = f"pwweb_{safe}"[:48]
    sink_name = base
    existing = {e["sink_name"] for e in _virtual_config}
    i = 2
    while sink_name in existing:
        sink_name = f"{base}_{i}"; i += 1

    entry = {"display_name": display_name, "sink_name": sink_name,
             "loopback_sink": loopback_sink}
    if _apply_virtual_sink(entry):
        _virtual_config.append(entry)
        _save_virtual_cfg()
        return entry
    return None


def _del_virtual_sink(sink_name: str):
    entry = next((e for e in _virtual_config if e["sink_name"] == sink_name), None)
    if not entry:
        return
    # Unload any source loopbacks that target this virtual sink
    for src_name in list(_source_routes):
        if _source_routes[src_name]["sink_name"] == sink_name:
            mid = _source_routes[src_name].get("mod_id")
            if mid:
                subprocess.run(["pactl", "unload-module", str(mid)],
                               check=False, capture_output=True, env=ENV_C)
            del _source_routes[src_name]
    _settings["source_routes"] = {n: e["sink_name"] for n, e in _source_routes.items()}
    _save_settings()
    for key in ("loopback_mod", "null_mod"):
        mid = entry.get(key)
        if mid is not None:
            subprocess.run(["pactl", "unload-module", str(mid)],
                           check=False, capture_output=True, env=ENV_C)
    _virtual_config[:] = [e for e in _virtual_config if e["sink_name"] != sink_name]
    _save_virtual_cfg()


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

def get_state() -> dict:
    sinks       = parse_blocks(run_pactl("list", "sinks"),       "Sink")
    sources     = parse_blocks(run_pactl("list", "sources"),     "Source")
    sink_inputs = parse_blocks(run_pactl("list", "sink-inputs"), "Sink Input")
    sources = [s for s in sources if s.get("monitorOfSink", "n/a") == "n/a"]
    sink_inputs = [si for si in sink_inputs if not si.get("corked")]

    # Mark virtual sinks so the UI can style them differently
    virtual_names = {e["sink_name"] for e in _virtual_config}
    for sink in sinks:
        if sink.get("name") in virtual_names:
            sink["virtual"] = True

    return {
        "type": "state",
        "sinks": sinks,
        "sources": sources,
        "sinkInputs": sink_inputs,
        "sounds": get_sounds(),
        "virtualSinks": [
            {"display_name": e["display_name"], "sink_name": e["sink_name"],
             "loopback_sink": e.get("loopback_sink", "")}
            for e in _virtual_config
        ],
        "sourceRoutes": {name: entry["sink_name"] for name, entry in _source_routes.items()},
        "settings": {
            "hidden_devices": _settings.get("hidden_devices", []),
            "ui": _settings.get("ui", {}),
        },
    }


# ---------------------------------------------------------------------------
# Real-time peak monitoring via parec subprocesses
# ---------------------------------------------------------------------------

class PeakMonitors:
    def __init__(self):
        self.monitors: dict[str, tuple] = {}
        self.peaks:    dict[str, float] = {}

    async def update(self, sinks: list, sources: list, sink_inputs: list):
        desired: dict[str, tuple[str, str]] = {}

        for sink in sinks:
            if sink.get("monitorSource"):
                desired[f"sink-{sink['index']}"] = ("device", sink["monitorSource"])

        for src in sources:
            if src.get("name"):
                desired[f"source-{src['index']}"] = ("device", src["name"])

        for si in sink_inputs:
            if not si.get("corked"):
                desired[f"sink-input-{si['index']}"] = ("stream", str(si["index"]))

        for key in list(self.monitors):
            if key not in desired:
                proc, task = self.monitors.pop(key)
                try:
                    task.cancel()
                    proc.kill()
                except Exception:
                    pass
                self.peaks.pop(key, None)

        for key, (mode, target) in desired.items():
            if key not in self.monitors:
                await self._start(key, mode, target)
            else:
                proc, _ = self.monitors[key]
                if proc.returncode is not None:
                    self.monitors.pop(key)
                    await self._start(key, mode, target)

    async def _start(self, key: str, mode: str, target: str):
        props = ["--property=media.role=production",
                 "--property=application.name=PulseWire Monitor",
                 "--property=application.id=pulsewire.monitor"]
        if mode == "stream":
            cmd = ["parec", "--monitor-stream", target,
                   "--format=s16le", f"--rate={PEAK_RATE}", "--channels=1",
                   "--latency-msec=100", *props]
        else:
            cmd = ["parec", "-d", target,
                   "--format=s16le", f"--rate={PEAK_RATE}", "--channels=1",
                   "--latency-msec=100", *props]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=ENV_C,
            )
            task = asyncio.create_task(self._read(key, proc))
            self.monitors[key] = (proc, task)
        except Exception as e:
            print(f"[peak] failed to start {key}: {e}")

    async def _read(self, key: str, proc):
        try:
            while True:
                data = await proc.stdout.read(PEAK_CHUNK)
                if not data:
                    break
                n = len(data) // 2
                if n == 0:
                    continue
                samples = struct.unpack(f"<{n}h", data[:n * 2])
                peak = max(abs(s) for s in samples) / 32768.0
                self.peaks[key] = round(peak * 100, 1)
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        finally:
            self.peaks.pop(key, None)
            self.monitors.pop(key, None)

    def stop_all(self):
        for key in list(self.monitors):
            proc, task = self.monitors.pop(key)
            try:
                task.cancel()
                proc.kill()
            except Exception:
                pass


peak_monitors = PeakMonitors()


# ---------------------------------------------------------------------------
# WebSocket server
# ---------------------------------------------------------------------------

async def broadcast(data: dict):
    if not CLIENTS:
        return
    msg = json.dumps(data)
    dead = set()
    for client in list(CLIENTS):
        try:
            await client.send(msg)
        except Exception:
            dead.add(client)
    CLIENTS.difference_update(dead)


async def ws_handler(websocket):
    CLIENTS.add(websocket)
    try:
        await websocket.send(json.dumps(get_state()))
        await websocket.send(json.dumps({"type": "media", **get_media_info()}))
        async for raw in websocket:
            try:
                msg    = json.loads(raw)
                t      = msg.get("type")
                target = msg.get("target", "")
                index  = str(msg.get("index", ""))

                if t == "set_volume":
                    vol = max(0, min(150, int(msg["volume"])))
                    cmds = {
                        "sink":       ["pactl", "set-sink-volume",       index, f"{vol}%"],
                        "source":     ["pactl", "set-source-volume",     index, f"{vol}%"],
                        "sink-input": ["pactl", "set-sink-input-volume", index, f"{vol}%"],
                    }
                    if target in cmds:
                        subprocess.run(cmds[target], check=False, env=ENV_C)

                elif t == "set_mute":
                    m = "1" if msg.get("mute") else "0"
                    cmds = {
                        "sink":       ["pactl", "set-sink-mute",       index, m],
                        "source":     ["pactl", "set-source-mute",     index, m],
                        "sink-input": ["pactl", "set-sink-input-mute", index, m],
                    }
                    if target in cmds:
                        subprocess.run(cmds[target], check=False, env=ENV_C)

                elif t == "move_sink_input":
                    sink_index = str(msg.get("sink", ""))
                    if index and sink_index:
                        subprocess.run(
                            ["pactl", "move-sink-input", index, sink_index],
                            check=False, env=ENV_C,
                        )

                elif t == "media_cmd":
                    action = msg.get("action", "")
                    player = msg.get("player", "")
                    if action in {"play-pause", "next", "previous", "stop"}:
                        cmd = ["playerctl"]
                        if player:
                            cmd += [f"--player={player}"]
                        cmd.append(action)
                        subprocess.run(cmd, check=False, env=ENV_C)
                        await asyncio.sleep(0.3)
                        await broadcast({"type": "media", **get_media_info()})

                elif t == "play_sound":
                    fname = msg.get("file", "")
                    sink  = msg.get("sink", "")
                    if fname and "/" not in fname and not fname.startswith("."):
                        fpath = SOUNDS_DIR / fname
                        if fpath.is_file():
                            asyncio.create_task(_play_sound(str(fpath), sink))

                elif t == "stop_sounds":
                    if _sound_proc and _sound_proc.returncode is None:
                        try:
                            _sound_proc.kill()
                        except Exception:
                            pass

                elif t == "save_settings":
                    if "hidden_devices" in msg:
                        _settings["hidden_devices"] = msg["hidden_devices"]
                    if "ui" in msg:
                        _settings["ui"] = msg["ui"]
                    _save_settings()

                elif t == "route_source":
                    src_name  = msg.get("source_name", "")
                    sink_name = msg.get("sink_name", "")
                    # Unload existing loopback for this source
                    old = _source_routes.pop(src_name, None)
                    if old and old.get("mod_id"):
                        subprocess.run(["pactl", "unload-module", str(old["mod_id"])],
                                       check=False, capture_output=True, env=ENV_C)
                    if src_name and sink_name:
                        r = subprocess.run(
                            ["pactl", "load-module", "module-loopback",
                             f"source={src_name}", f"sink={sink_name}",
                             "latency_msec=50"],
                            capture_output=True, text=True, env=ENV_C, timeout=5,
                        )
                        if r.returncode == 0:
                            _source_routes[src_name] = {
                                "mod_id": int(r.stdout.strip()),
                                "sink_name": sink_name,
                            }
                    # Always persist the updated route table (including removals)
                    _settings["source_routes"] = {n: e["sink_name"] for n, e in _source_routes.items()}
                    _save_settings()

                elif t == "rescan_sounds":
                    await websocket.send(json.dumps({"type": "sounds", "sounds": get_sounds()}))

                elif t == "create_virtual_sink":
                    name     = msg.get("name", "").strip()[:40]
                    loopback = msg.get("loopback_sink", "")
                    if name:
                        entry = _new_virtual_sink(name, loopback)
                        if entry:
                            state = get_state()
                            await peak_monitors.update(state["sinks"], state["sources"], state["sinkInputs"])
                            await broadcast(state)

                elif t == "delete_virtual_sink":
                    sn = msg.get("sink_name", "")
                    if any(e["sink_name"] == sn for e in _virtual_config):
                        _del_virtual_sink(sn)
                        state = get_state()
                        await peak_monitors.update(state["sinks"], state["sources"], state["sinkInputs"])
                        await broadcast(state)

            except Exception as e:
                print(f"[ws] message error: {e}")
    except Exception:
        pass
    finally:
        CLIENTS.discard(websocket)


# ---------------------------------------------------------------------------
# PulseAudio event subscription
# ---------------------------------------------------------------------------

async def event_watcher():
    pending: asyncio.Task | None = None

    async def schedule_update():
        nonlocal pending
        if pending and not pending.done():
            pending.cancel()

        async def do_update():
            await asyncio.sleep(0.2)
            state = get_state()
            await peak_monitors.update(state["sinks"], state["sources"], state["sinkInputs"])
            await broadcast(state)

        pending = asyncio.create_task(do_update())

    while True:
        try:
            proc = await asyncio.create_subprocess_exec(
                "pactl", "subscribe",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=ENV_C,
            )
            async for line in proc.stdout:
                if b"Event '" in line:
                    await schedule_update()
            await proc.wait()
        except asyncio.CancelledError:
            return
        except Exception as e:
            print(f"[event watcher] {e}")
        await asyncio.sleep(1)


async def peak_broadcaster():
    while True:
        await asyncio.sleep(0.05)
        if CLIENTS and peak_monitors.peaks:
            await broadcast({"type": "peaks", "data": dict(peak_monitors.peaks)})


async def media_broadcaster():
    last: dict = {}
    while True:
        await asyncio.sleep(2)
        info = get_media_info()
        if info != last:
            last = info.copy()
            await broadcast({"type": "media", **info})


# ---------------------------------------------------------------------------
# HTTP server for static files
# ---------------------------------------------------------------------------

def _http_thread():
    os.chdir(PUBLIC_DIR)

    class QuietHandler(SimpleHTTPRequestHandler):
        def log_message(self, *_):
            pass

    httpd = HTTPServer(("0.0.0.0", HTTP_PORT), QuietHandler)
    httpd.serve_forever()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def main():
    _load_settings()
    _load_virtual_cfg()
    _restore_virtual_sinks()
    _restore_source_routes()
    threading.Thread(target=_http_thread, daemon=True).start()

    state = get_state()
    await peak_monitors.update(state["sinks"], state["sources"], state["sinkInputs"])

    async with serve(ws_handler, "0.0.0.0", WS_PORT):
        print("PipeDeck started")
        print(f"  Local:   http://localhost:{HTTP_PORT}")
        print(f"  Network: http://<YOUR-IP>:{HTTP_PORT}")
        await asyncio.gather(
            event_watcher(),
            peak_broadcaster(),
            media_broadcaster(),
        )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        peak_monitors.stop_all()
        print("\nStopped.")
