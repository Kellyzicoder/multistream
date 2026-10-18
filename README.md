# Multistream

Send one OBS stream to Facebook, YouTube, Instagram (and more) at the same time.

OBS sends one stream to this app on your computer. The app copies it to each platform. The video is copied, not re-encoded, so it uses very little CPU.

ffmpeg is built into the desktop app, so you do not need to install it.

## Try it on your computer (Mac or Windows)

You need Node.js (version 18 or newer) from nodejs.org.

1. Open a terminal in this folder.
2. Run `npm install` (one time).
3. Run `npm run app`. A window opens with the dashboard.

## Make the Windows installer for the church PC

Build the Windows installer on a Windows PC. The ffmpeg that comes with the app is downloaded for the computer where you run `npm install`, so a Windows installer has to be built on Windows.

1. On a Windows PC, install Node.js and open this folder in a terminal (PowerShell).
2. Run `npm install`
3. Run `npm run dist`
4. The installer appears in the `dist` folder (a file ending in `.exe`). Copy it to the church PC and run it.

To make a Mac app instead, run the same two commands on a Mac. The file in `dist` ends in `.dmg`.

## Every time you go live

1. Open **Multistream**.
2. For each platform, click **Edit** and paste its stream URL and stream key.
   - Instagram gives you a new key each time you go live.
3. In OBS: Settings → Stream → Service **Custom**
   - Server: `rtmp://localhost:1935/live`
   - Stream key: `obs`
4. Click **Start Streaming** in OBS. The app shows each platform as Live or Problem.
5. While live, the window shows a large video preview with LIVE and the time on it. Under it is one bar with Health, resolution, bitrate, frame rate, keyframe interval and audio.
   - Keyframe interval should be 2 seconds. Facebook and YouTube say 4 seconds at most. If it is higher, the bar turns amber. In OBS go to Settings → Output → Streaming → Keyframe Interval and set it to 2. The switch under the preview turns the preview off if you want to save a little power.
6. **Go live on Facebook / YouTube:** start OBS first, then press **Go live on Facebook** or **Go live on YouTube** in the app. Tick **Test mode** first to try it without the public seeing it.
   - Facebook: press **Facebook Page** once and save the Page ID and token.
   - YouTube: press **YouTube**, choose the .json file from Google, then **Connect YouTube** and sign in with the church account. Keep a channel named "YouTube" in the list (and one named "Facebook").
   - **Lock:** the Go live buttons stay grey until you hold **Locked: hold to unlock** for 1.5 seconds. It then unlocks for 15 seconds and works for one press, so nobody goes live by accident.
   - From a phone on the same Wi-Fi (Settings, Control from phone) you can press Go live too. The logins stay on the church computer.
   - Instagram stays manual: press **Go live** in Instagram.

## Control it from a phone (same Wi-Fi)

1. In the app click **Settings** (right side), turn on **Allow other devices** and type a password (at least 6 characters). Click **Save**.
2. The box shows an address like `http://192.168.1.20:3000`. Open that address in the browser on your phone or another computer on the same Wi-Fi.
3. Log in with the password. You see the same screen as the app and can switch channels on and off.

- Only the app on the church computer can change this setting. Other devices cannot.
- Turning it off, or setting a new password, logs everyone out.
- The video preview on the phone uses port 8000 on the church computer. Windows may ask to allow the app on the network. Choose **Private networks**.
- This works only on the same Wi-Fi. It is not on the internet.

## Notes

- Saved destinations and keys are stored in the app's own data folder on that computer only. Do not share them.
- If one platform fails, the others keep going. Use **Restart** to retry just that one.
- Windows may ask if the app can use the network the first time. If OBS runs on the same PC, either answer works. If OBS runs on a different PC, allow it.
- The app needs ports 3000, 1935 and 8000 to be free. Port 8000 is the video preview (it is built in with the flv.js player, installed by `npm install`). Anyone on the same network can open it while you are live, so only use it on a network you trust. It will tell you if another program is using one.
- Keep Remote access off when you do not need it.
- You can still run it without the window: `npm start`, then open http://localhost:3000. This way needs ffmpeg installed on the computer.

## OBS scenes (switch scenes from the dashboard or a phone)
1. In OBS open **Tools → WebSocket Server Settings**. Tick **Enable WebSocket server**, set a password, press OK. (Needs OBS 28 or newer.)
2. In Multistream press **Connect OBS** (under the preview). Switch **Connect to OBS** on, keep port 4455, type the same password, press Save.
3. Your OBS scenes show as tiles under the preview. Tap a tile to switch to that scene. The red tile marked ON AIR is the scene OBS is showing now.
4. **Small / Medium / Large** changes the tile size, and **Pictures** turns the little live pictures off if you only want names. These choices are saved on each device.
5. **Audio levels** show under the tiles: one bar for each sound in OBS (green is fine, orange is loud, red is too loud), with a thin line for the loudest recent peak. A sound that is muted in OBS shows a MUTED tag. These are for watching only. Use the **Show** switch to turn them off. They only run while the page is open, so OBS is not kept busy the rest of the time.
The password is saved only on the church computer and is never sent to the phone. Only the church computer can change the OBS connection. A phone that is logged in can switch scenes.

## Appearance and accessibility
Press **Access** in the right-hand menu. You can pick a dark, light or system theme, choose the main colour (or type your own), make text bigger, turn on high contrast, use colour-blind friendly colours, make buttons bigger, and stop animations. Changes show straight away. Press **Save changes** to keep them, or **Cancel** to go back. Choices are saved on each device (the phone and the church computer are separate). **Reset all** puts everything back to the default.

## Studio (replaces OBS)

Menu next to the title, then Studio (on the church PC only). It opens in its own window.

- **Import OBS scenes:** in OBS choose Scene Collection, then Export. In the Studio press "Import OBS scenes..." and pick that file. Pictures and videos are read from the same paths OBS used, so run this on the church PC.
- **Sources:** camera and capture cards, pictures, video files (with sound), screen capture, web pages (like the lyrics page), phone camera over Wi-Fi (DroidCam), text and colours.
- **Sound:** every input has a volume, mute and level meter. Tick which scenes each input is heard in.
- **Send:** "Start sending" sends the ON AIR picture and the sound into the relay, the same place OBS sent to.
- **Control Room:** the Engine box picks Studio or OBS. Automatic uses the Studio when it is open, otherwise OBS. In Studio mode you can also switch items such as lowerthirds on and off from the Control Room (works on the phone too).
- OBS is untouched and stays as the backup.
