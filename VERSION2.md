# Multistream 2

Version 2 is a separate app. Version 1 (the `main` branch) is not changed.

**Goal:** make the whole show inside Multistream, so OBS is not needed. OBS still works as a backup.

## How it is kept apart from Version 1
- Own branch: `v2`. Version 1 is `main`.
- Own installer names: `Multistream2-Setup.exe`, `Multistream2-Mac-*.dmg`, `Multistream2-Linux.AppImage`.
- Own app name ("Multistream 2") and own app id, so both can be installed on the same computer. Version 2 keeps its own saved keys and settings. You type them in again once.
- Own release: **v2-latest** (version numbers 2.0.N). Version 1 stays on **latest** (1.0.N). Each one updates only from its own release.
- Both use the same ports (3000, 1935, 8000), so run only one at a time. The app tells you if the other is open.

## What Version 2 has now
The Studio from Version 1: cameras, screen, pictures, video, text, web pages, a phone camera, a sound mixer, OBS scene import, and Start sending.

## Plan (what OBS does that we still need to build)
| Step | What | Status |
|---|---|---|
| 1 | Separate Version 2 app, installer and release | done |
| 2 | Smooth transitions between scenes (cut, fade, slide, dip to black) | done |
| 3 | Steady for 2 hours or more: graphics card encoding, reconnect by itself | done |
| 4 | Sound tools: per-input volume, mute, delay, noise gate, compressor | built (PR #28) |
| 5 | Picture tools on items: crop, colour fix, chroma key (green screen), shape, flip | built (PR #29) |
| 6 | Lower thirds, countdown timer, clock | built (PR #30) |
| 7 | Recording from the Studio itself, with its own quality settings | built (PR #31) |
| 8 | Hotkeys and a second preview window | built (PR #32). Keys work only when the Studio window is in front |
| 9 | Virtual camera for Zoom (needs a special driver on Windows and Mac) | not started, hardest. For now: share the Preview window in Zoom |
| 10 | Capture cards and NDI | capture cards that show up as a camera already work as a Camera source. NDI not started |
| 11 | Plugins (OBS plugins will not work in Version 2) | not planned |

The Studio draws everything in the app window and encodes it with ffmpeg. That is simpler than OBS, but it uses more computer power on a weak PC. Test on the church PC early.
