# Multistream 3

Version 3 is a separate app. Version 1 (`main`) and Version 2 (`v2`) are not changed.

**Goal:** a free replacement for OBS + Restream that is simple for a beginner, with **no localhost**.

## How it is kept apart
- Own branch: `v3`.
- Own app name ("Multistream 3"), own app id, own saved settings. You type your keys in again once.
- Own installers: `Multistream3-Setup.exe`, `Multistream3-Mac-*.dmg`, `Multistream3-Linux.AppImage`.
- Own release: **v3-latest** (version numbers 3.0.N).

## What "no localhost" means
| Before (Version 1 and 2) | Version 3 |
|---|---|
| The app windows were web pages from `http://localhost:3000` | The windows load from inside the app (`app://multistream`). No port. |
| The Studio sent video to a local RTMP server (`localhost:1935`) | The Studio hands its video straight to the app's video hub. No port. |
| The preview used a local video server (`localhost:8000`) | The preview comes from the same hub. No port. |
| Studio video, recording and virtual camera used WebSockets on localhost | They use messages inside the app. No port. |

Version 3 has **no OBS connection** at all (no OBS backup, no OBS control). You can still copy scenes from an exported OBS scene file with **Import Scenes...** (that is only reading a file).

Ports are only opened when you ask for them:
- **Phone control** (Settings, Phone): port 3000, so a phone on the Wi-Fi can open the dashboard. Off by default.
- **YouTube sign-in**: Google sends your browser back to this computer once. A listener opens on this computer only while you sign in, then closes (after 5 minutes at most).

## Screens
- **Studio** looks like OBS (Studio Mode): **Preview** on the left, **Program** (what viewers see) on the right, a **Transition** button between them. Along the bottom: **Scenes**, **Sources**, **Audio Mixer**, **Scene Transitions** and **Controls** (Start Streaming, Start Recording, Start Virtual Camera, Projector, Import Scenes, Shortcuts). Double-click a source (or press the gear) to open its **Properties** window. The status bar shows the LIVE and REC clocks.
- **Dashboard**: a "Waiting for the Studio" screen with one **Open Studio** button. Thumbnail, recording and the check list are folded under **More options**.

## Studio tools (what you can do, and what is not there)
**Settings (in the Studio), like OBS with Restream's channels.** A list on the left: General (open the Studio in a new window or the same window, snapping, "are you sure" before stopping, Import Scenes, Shortcuts, Preview window), Channels (every place your video goes: on/off, status, edit name/URL/key, 1080p limit, restart, remove, add YouTube / Facebook / other), Video, Recording, Audio, Hotkeys (a list, they cannot be changed yet) and Advanced (reset). YouTube and Facebook sign-in, titles and Go Live stay in the dashboard under Settings.

**Studio window choice.** Dashboard > Settings > Appearance > "Open the Studio in" (also in Studio Settings > General): a new window, or the same window. In the same window, the Studio has a "Dashboard" button to go back. Going back stops streaming and recording (it asks first), because the Studio page is closed.

**Picture size.** Settings > Video: 720p, 1080p, 1080p at 60 frames, 1440p, or 4K (30 frames). YouTube gets the video as it is. Facebook and Instagram take 1080p at most (Facebook Live API reference: 1920x1080, 60 frames, 9000 kbps), so for those two the app makes a smaller 1080p copy by itself and the dashboard says so. Recording can be up to 4K. The virtual camera stays at 720p.

**Video Capture Device** (webcam, ATEM Mini, capture box). Pick the device, a resolution (up to 4K) and a frame rate. The Properties window shows what the device really gives. Plug a device in while the Studio is open and it appears in the list by itself.

**Preview editing** (like OBS): click an item to select it, drag to move, drag a corner (keeps the shape) or an edge to resize, hold Alt and drag an edge to crop, Shift on a corner changes the shape, Ctrl turns snapping off. Items snap to the edges and centre of the picture and to each other. Arrow keys move the item (Shift = 10), Delete removes it. A "Lock in place" tick protects an item.

**Window capture.** Add source > Window: pick a program from a list with small pictures. If you close it and open it again, the Studio finds it again by its name. A window that is not there gives a message; it is never swapped for a screen.

**Sound.** Each input has Tools: listen with headphones (monitor off / only / and stream), delay, low cut, bass-mid-treble, noise gate, compressor, limiter. Settings > Audio picks the monitoring output. "Computer sound" (the sound this PC plays) is in the Windows app; on a Mac use BlackHole as a Sound input.

**Not in Version 3 (OBS has it):** stinger transitions, video filters like blur or colour lookup, groups and scenes inside scenes, several audio tracks in one recording, replay buffer, NDI, global hotkeys when the Studio is not the window in front, plugins and scripts, a virtual camera on Mac, 4K at 60 frames.

## Tests
- `npm test`: the video hub, the in-app requests, the output sizes (720p to 4K) and the 1080p limit for Facebook/Instagram (a real 1440p picture is turned into 1080p).
- `npm run test:app`: starts the real app with a fake YouTube, checks no ports are open, sends from the Studio, checks the preview, records, checks there is no OBS connection, and checks phone control opens and closes its port. It also drags, resizes and crops items in the Preview with the mouse, checks the camera settings, the sound monitoring wiring, the screen and window lists, and sends 1080p to a fake YouTube and a fake Facebook (which must get the smaller copy). GitHub runs this on every push and keeps screenshots.

## Liquid Glass look
Rounded corners, frosted translucent panels with blur, light edges and a soft accent glow, in the Studio and the dashboard, in dark and light, following the accent colour. It is switched off by Appearance > High contrast and by the system's reduce-transparency setting. Checked in Chromium screenshots and the GitHub tests only; not yet seen on a Mac or the church PC.

## Movable panels
In the Studio, drag a panel's title (Scenes, Sources, Audio Mixer, Scene Transitions, Controls) to put it in a new place on the bottom row. Drag it up, or press the arrow button on its title, to float it as its own window that you can move and resize. Drag it to the far left or right edge to dock it beside the pictures. The audio mixer has vertical faders and meters like OBS; the per-input tools (input, headphones, delay, low cut, bass/treble, gate, compressor, limiter) open from each strip's Tools button. Drop it on the bottom row, or press the arrow again, to dock it. The layout is saved on this device. Settings, General, Put the panels back resets it.

## Studio Mode and panel sizes
Controls, Studio Mode (like OBS): on shows Preview and Program with a Transition button; off shows only the live picture, and clicking a scene puts it on air straight away. Panels can be resized with limits: drag the line above the bottom row, the lines between panels, or the line beside a left or right column (double-click a line to reset it). Settings, General, Put the panels back resets everything. The Control Room page fills the whole window.

## Control Room on a display, and projectors
Pressing Control Room at the top asks where to show it: in this window, in a new window, or full screen on one of the connected displays (Esc leaves full screen). In the Studio, right-click the Preview or Program picture to show it full screen on a display, or in its own window (Esc closes it, double-click toggles full screen), to put the Preview scene on air, or to turn Studio Mode on or off. The display choices need the desktop app and more than one screen to be useful; I have only tried them with pretend screens, not on real ones.

## OBS keyboard shortcuts
With an item selected: Ctrl+F fit to screen, Ctrl+S stretch to screen, Ctrl+D centre, Ctrl+R reset transform, Ctrl+E edit (properties), Ctrl+C / Ctrl+V copy and paste, Ctrl+Up / Down / Home / End move in front or behind, F2 rename, Esc select nothing. Anywhere: Ctrl+Z undo and Ctrl+Shift+Z (or Ctrl+Y) redo for changes to scenes and items (up to 60 steps; not for sound settings), F11 full screen, Ctrl+, Settings. The full list is in Settings, Hotkeys. Streaming and recording hotkeys are not set in OBS by default, so the Studio keeps its own (R, Shift+G, 1-9). They still cannot be changed. Rotate is not in the Studio, so there is no rotate key.
