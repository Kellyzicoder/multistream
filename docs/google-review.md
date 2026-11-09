# Google review (sensitive scope verification) – ready to paste

Google Cloud project: multistream-511914 · Google Auth Platform → Verification centre

## What is already done

- App name, support email, developer contact: done
- Home page: https://multistream-three.vercel.app/about/
- Privacy policy: https://multistream-three.vercel.app/privacy/ (same website as the home page)
- Authorised domain: multistream-three.vercel.app
- Website ownership: verified in Google Search Console (the file googleb9737b267f011538.html must stay on the site)
- Logo: none (adding one means brand checks; not needed)

## Scope justification (paste into "How will the scopes be used?")

Scope: https://www.googleapis.com/auth/youtube

Multistream is a desktop app (Windows and Mac) that churches use to stream a service to YouTube and other sites at the same time. When the user presses "Start streaming", the app creates and runs the live stream on the user's own channel. It needs the youtube scope for:

1. liveBroadcasts.insert, liveStreams.insert, liveBroadcasts.bind: create the live broadcast and its stream with the title, description and privacy the user chose.
2. liveBroadcasts.transition: start the broadcast (go live) and end it when the user presses Stop streaming.
3. liveBroadcasts.update: change the title and description while live ("Update title for all channels").
4. thumbnails.set: set the thumbnail the user uploaded for the stream.
5. liveChatMessages.list: show the live chat inside the app.
6. videos.list, channels.list: show live viewers and likes, and the channel name the user is signed in with.
7. videos.insert (only if the user turns on "Upload to YouTube when the stream ends"): upload the recording of the service.

Why a narrower scope is not enough: youtube.readonly cannot create, start, end or update a live broadcast. youtube.upload only covers uploading videos, not live broadcasts. youtube.force-ssl is equally broad. Creating and controlling live broadcasts needs the youtube scope.

Data handling: the refresh token is stored only on the user's computer, encrypted with the operating system's protection (Windows DPAPI / Mac Keychain). The app talks directly to the YouTube Data API; there is no Multistream server, and no data is shared with anyone.

## Demo video (record, upload to YouTube as Unlisted, paste the link)

Keep it 2–4 minutes, in English, on the real app.

1. Show the Multistream app open on Go Live, with YouTube not connected.
2. Open Settings → Stream → Connect YouTube.
3. The Google sign-in opens in the browser. Show the address bar clearly: it must show client_id=... (your OAuth client ID).
4. Pick the Google account. Show the consent screen with the app name "Multistream" and the YouTube permission. Press Continue / Allow.
5. Back in the app, show YouTube as connected (channel name).
6. Type a title, set Who can watch to "Only me (test)" or Private, and press Start streaming. Show the live being created on YouTube Studio.
7. Show the live chat and the viewer count in the app.
8. Press "Update title for all channels" and show the new title on YouTube.
9. Press Stop streaming and show the broadcast ending on YouTube.
10. (If you use it) show "Upload to YouTube when the stream ends" and the uploaded video.

## Then

Verification centre → Prepare for verification → fill in the scope justification and the video link → Submit. Google says up to 10 days; they may email asking for changes.
