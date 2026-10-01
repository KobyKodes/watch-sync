# Watch Sync

A Chrome extension that keeps an HTML5 video playing in sync for everyone in a room, with a chat drawn over the video. It works on any site with a `<video>` element, including players inside cross-origin iframes. It syncs play, pause and seek, corrects drift, and lets late joiners catch up.

```
extension/   Chrome extension (Manifest V3)
server/      WebSocket relay (Node, one dependency: ws)
test/        Test site with the video in a cross-origin iframe, plus an end-to-end test
```

## Run it locally

```sh
cd server && npm install && npm start      # relay on ws://localhost:8787
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the `extension/` folder.
2. Open the page with the video, click the Watch Sync icon, enter your name and click **Create room**.
3. Click the room code to copy it, or click **Copy invite link** to copy the page address, and send it to your friend. They open the same page, enter the room code and click **Join room**.

The extension always connects to the hosted relay at `wss://watch-sync-relay-hs9v.onrender.com`, set in `extension/config.js`. There's no server setting in the popup. To develop against a relay on your own machine, temporarily change that file to `ws://localhost:8787` and reload the extension. The tests do this for you by loading a copy of the extension pointed at their own local relay.

The relay runs on Render's free tier, which puts it to sleep when it's idle. Waking it takes up to a minute. Opening the popup sends the relay a wake-up request, and the popup shows "Waking up the server…" with a timer until the relay answers, then "Server ready". If you join while it's still waking, you connect as soon as it's up.

## Deploy the relay

`server/` is a standard Node app that listens on `$PORT`. It runs on Render, Railway, Fly.io or any VPS. Once it's deployed, set `WATCH_SYNC_SERVER` in `extension/config.js` to `wss://your-app.example.com`. Use `wss://`, not `ws://`, for anything that isn't localhost.

## How it works

The rule is to wait for everyone. The room never plays while someone is buffering or watching an ad.

- **The server owns playback.** Each room has one state: paused, waiting or playing, plus a position and a start time. Clients send what the viewer did (play, pause, seek) and report whether they're ready. Every change gets an epoch number, and a readiness report only counts for the epoch it was made against.
- **Synced starts.** Each client keeps its clock in step with the server using pings (the lowest-latency sample wins). When everyone is ready, the server schedules playback about 0.7 s in the future, and every client starts at that exact moment.
- **Buffering holds the room.** A viewer whose playhead stalls for more than 0.7 s reports "buffering". Everyone pauses at the stalled viewer's position, so nobody misses anything, and the room resumes when the stalled viewer has that position buffered.
- **Ads hold the room too.** The viewer with the ad is left alone so the ad can play out, and their player's own play and pause events during the ad are ignored. Ads are detected by:
  - ad-state classes that common players (YouTube, JW Player, Video.js, IMA, Plyr) put on the player
  - visible "skip ad" or countdown elements
  - the show's `<video>` switching to a short clip
  - a separate ad player covering the show
  - iframes from known ad networks, which send heartbeats while their ad plays
  - the **Hold for me** button in the popup, for anything detection misses

  Players often pause the show just before an ad appears. If an ad shows up within 4 s of a pause, that pause is taken back, and the room waits instead of pausing.
- **Drift correction.** Small drift (over 0.05 s) is corrected by nudging playback speed by up to 10%, with no visible jump. Anything over 1.5 s is fixed with a seek.
- **Sync everyone.** A button in the popup that anyone can press if things seem off. Everyone lines up on the room's position, every browser re-measures its clock against the server, and playback restarts together. This fixes drift that automatic correction can't detect, such as a stale clock measurement after a laptop wakes from sleep.
- **Joining late never rewinds the room.** A video that just appeared starts wherever its player puts it, usually 0:00. This covers a late joiner, or a click-to-play player that only creates its `<video>` when you press play. Until that video has caught up with the room once, its play, pause and seek events are treated as the player starting up and ignored, and the viewer is brought to the room's position instead. A new room starts where its creator is, so making a room 20 minutes into a movie keeps everyone at 20 minutes.
- **Late joiners start on standby.** Someone who joins a room that's already under way isn't auto-started: the extension leaves their page alone, the room doesn't wait for them, and they see "Press play to join the room". On many sites, pressing play is what opens the player. Once they press play, they're lined up with everyone else. The popup lists them as "hasn't pressed play" until then.
- **Guests are taken to the room's page.** A guest who joins from a page without a video, such as a new tab, is sent to the page the room was created on. Someone already on a page with a video stays where they are.
- **Play without waiting.** Anyone can use this to stop waiting for a stuck viewer. That viewer catches up automatically once they're ready again.
- **Content script** (`content.js`): runs in every frame (`all_frames` + `match_origin_as_fallback`) and locks onto the show's video, so an overlay ad player can't take its place.
- **Background worker** (`background.js`): holds the WebSocket, so page CSP can't block it.

## Chat

The chat is a Liquid Glass-style overlay drawn over the video. It's built to stay out of the picture:

- **Previews:** new messages float up as small glass bubbles on the right edge, above the player controls, and fade after 6 seconds.
- **Chat button:** appears in the top corner only while the mouse moves, like player controls. Press ⌥C (Alt+C) to open or close the chat.
- **Any corner:** drag the panel by its header, drag the chat button, or press and hold a floating message, and the chat snaps to the nearest corner of the video. The spot is remembered for each site, so a player with controls in an odd place only needs moving once.
- **Unread count:** messages that arrive while the chat is closed, or while the tab is in the background, are counted on the toolbar icon until you open the chat.
- **Panel:** narrow, only as tall as its messages up to half the video's height, and it fades to half opacity after 4 seconds without typing or hovering. When it's full, scroll up to read older messages; it keeps the last 200. While you're scrolled up, new messages don't move you, and a **New messages ↓** button takes you back to the latest. Sending a message also jumps back down.
- **Replies:** swipe right on any message to reply to it, with a mouse drag, a touch, or a two-finger trackpad swipe. A "Replying to …" bar appears above the text box; Esc or × cancels it. The sent message shows a quote of the original above it. The server fills in the quote from its history, so a reply can't misquote anyone.
- **Emoji:** the smiley button opens two rows of reaction emoji that scroll sideways. Clicking one inserts it at the cursor.
- **Fullscreen:** the chat works whether the site fullscreens its player container or the `<video>` itself. For the `<video>` case, the extension also makes the video's parent fullscreen, holds the chat there as a transparent, click-through layer, and undoes it all when you exit.
- **Keyboard:** keys typed in the chat never reach the player, so space, "f" and the arrow keys don't pause, fullscreen or seek.
- **Server:** keeps the last 50 messages so late joiners see recent history, posts "joined" and "left" notes, and limits each person to 8 messages per 5 seconds.

In fullscreen, Esc exits fullscreen as well as closing the chat, because the browser handles Esc there. Use the × to close just the chat.

## Test

```sh
cd test && npm install && ./make-media.sh
CHROME_PATH="/path/to/Chromium or Chrome for Testing" npm run e2e
```

The test drives real browser profiles against a player in a cross-origin iframe. The test server throttles and stalls each viewer's network separately, so the buffering is real. It covers:

- synced start, seek and pause, from either side
- holding the room for buffering after a seek, and for a stall mid-playback
- the three ad styles: same-element swap, overlay player, and ad-network iframe
- manual hold, then play without waiting, then catching up
- chat delivery, keys not leaking to the player, chat in `<video>` fullscreen with cleanup on exit, and history for late joiners
- swipe-to-reply by drag and by trackpad, reply quotes, the emoji picker, and the half-height cap that drops old messages
- moving the chat to another corner (header, chat button, and press-and-hold on a message) and saving it per site
- the unread count on the toolbar icon, for a closed chat and for a background tab
- drift correction by speed alone
- a late joiner
- leaving the room

Branded Google Chrome no longer accepts `--load-extension`, so point `CHROME_PATH` at Chromium or Chrome for Testing. Set `HEADED=1` to watch it run. `npm run site` serves just the test site, at http://localhost:8080/?u=you. `node shots.js <dir>` saves screenshots of the chat states for design review. The tests run their own relay on port 8797, so a relay you're already running on 8787 isn't affected.

## Known limits

- Everyone must load the same video. If mirrors differ (different intros or cuts), positions won't line up.
- Ad detection is heuristic. An ad player that uses none of the signals above, on a site that isn't recognized, needs **Hold for me**.
- Videos inside *closed* shadow roots and players drawn on a canvas aren't detected.
- If you press pause while the room is already waiting, nothing happens, because your video is already paused. The room still resumes when everyone is ready.
