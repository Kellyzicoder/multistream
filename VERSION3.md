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

## Tests
- `npm test`: the video hub and the in-app requests.
- `npm run test:app`: starts the real app with a fake YouTube, checks no ports are open, sends from the Studio, checks the preview, records, checks there is no OBS connection, and checks phone control opens and closes its port. GitHub runs this on every push and keeps screenshots.
