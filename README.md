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
6. **Go live:** start OBS first, then press **Go live** next to YouTube or Facebook in the **Go live** box. Leave **Private test** switched on to try it without the public seeing it. Switch it off for the real service.
   - Facebook: press **Set up** next to Facebook (it opens **Settings → Facebook**), type the Page ID and token, then press **OK**.
   - YouTube: press **Set up** next to YouTube (it opens **Settings → YouTube**), choose the .json file from Google, then **Connect YouTube** and sign in with the church account. If there is no channel named "YouTube" (or "Facebook") yet, Go live adds it for you.
   - There is no lock. When Private test is off, the app asks "Continue?" once before it goes live in public.
   - From a phone on the same Wi-Fi (set up in **Settings → Phone**) you can press Go live too. The logins stay on the church computer.
   - **Title and thumbnail:** type the title in the **Title** box (leave it empty to use "Live from FCCHQ" and the date). Press **Choose picture** to pick a PNG or JPG thumbnail (1280×720 is best). The title goes to YouTube and Facebook. The thumbnail goes to YouTube only. The title is remembered. Choose the picture on the church computer. If YouTube refuses the picture, you still go live and the app tells you why.
   - Instagram stays manual: press **Go live** in Instagram.

## Control it from a phone (same Wi-Fi)

1. In the app click **Settings** (top right), open **Phone**, turn on **Allow other devices** and type a password (at least 6 characters). Click **OK**.
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
2. In Multistream press **Connect OBS** (under the preview). Switch **Connect to OBS** on, keep port 4455, type the same password, press **OK**. (**Connect OBS** under the preview opens the same page, **Settings → OBS**.)
3. Your OBS scenes show as tiles under the preview. Tap a tile to switch to that scene. The red tile marked ON AIR is the scene OBS is showing now.
4. **Small / Medium / Large** changes the tile size, and **Pictures** turns the little live pictures off if you only want names. These choices are saved on each device.
5. **Audio levels** show under the tiles: one bar for each sound in OBS (green is fine, orange is loud, red is too loud), with a thin line for the loudest recent peak. A sound that is muted in OBS shows a MUTED tag. These are for watching only. Use the **Show** switch to turn them off. They only run while the page is open, so OBS is not kept busy the rest of the time.
The password is saved only on the church computer and is never sent to the phone. Only the church computer can change the OBS connection. A phone that is logged in can switch scenes.

## Appearance and accessibility
Press **Settings** at the top right. The left side lists the sections: Appearance, Accessibility, YouTube, Facebook, OBS and Phone. **Appearance** and **Accessibility** let you pick a dark, light or system theme, choose the main colour (or type your own), make text bigger, turn on high contrast, use colour-blind friendly colours, make buttons bigger, and stop animations. Changes show straight away. Press **OK** to save and close, **Apply** to save and stay, or **Cancel** to go back. Choices are saved on each device (the phone and the church computer are separate). **Reset all** puts everything back to the default.

## Studio (replaces OBS)

Menu next to the title, then Studio (on the church PC only). It opens in its own window.

- **Import OBS scenes:** in OBS choose Scene Collection, then Export. In the Studio press "Import OBS scenes..." and pick that file. Pictures and videos are read from the same paths OBS used, so run this on the church PC.
- **Sources:** camera and capture cards, pictures, video files (with sound), screen capture, web pages (like the lyrics page), phone camera over Wi-Fi (DroidCam), text and colours.
- **Sound:** every input has a volume, mute and level meter. Tick which scenes each input is heard in.
- **Send:** "Start sending" sends the ON AIR picture and the sound into the relay, the same place OBS sent to.
- **Control Room:** the Engine box picks Studio or OBS. Automatic uses the Studio when it is open, otherwise OBS. In Studio mode you can also switch items such as lowerthirds on and off from the Control Room (works on the phone too).
- OBS is untouched and stays as the backup.

## Mac install

The app is not signed with a paid Apple account. Open the .dmg, drag Multistream to Applications, then right-click the app and choose Open (once). If macOS says the app is "damaged", run this once in Terminal: `xattr -cr /Applications/Multistream.app`

## Vercel preview

The Vercel link is a demo only: it shows the pages with sample data. The real app runs on the church PC, because it needs ffmpeg and a video port that Vercel does not have.

## Recording

- Press **Record** in the Go live box while OBS is streaming. Press **Stop** when you are done. It saves the same picture and sound OBS sends, to a file on this computer.
- Files go in the **Videos → Multistream** folder (Settings → Recording shows the exact place and has an **Open folder** button and a list of recent files).
- The file is an `.mkv`. It still plays if the power goes out. VLC plays it. To get an `.mp4`, open it in VLC or OBS (File → Remux Recordings).
- Settings → Recording also has **Record when OBS starts**, so no button is needed.
- It uses almost no computer power because it does not re-encode the video. Check there is enough free disk space: an hour at 4.5 Mbps is about 2 GB.

## Chat

- After you press **Go live**, the **Chat** box (right side, under Channels) shows YouTube live chat and Facebook live comments in one list. It also shows on the phone.
- It only reads. You cannot reply, delete or post from it.
- YouTube: asked every 6 seconds or slower. Each ask uses 5 of the 10,000 free daily quota units, so about 3,000 units an hour. That is fine for a service of 2 to 3 hours, but it shares the quota with Go live.
- Facebook: needs a Page token that is allowed to read comments (the same token you pasted for Go live). If Facebook says it is not allowed, the Chat box shows Facebook's message.
- Chat starts from the Go live button, and stops when OBS stops. It starts empty each time OBS starts.
