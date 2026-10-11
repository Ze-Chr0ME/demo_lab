# CS2 ClipMaker

Turns your CS2 demos into highlight clips automatically. It reads each demo to find your
**multi-kills (3K/4K/ace)**, **clutches** and **special kills** (no-scopes, wallbangs, through smoke,
while flashed, knife, Zeus, collaterals). Then CS2 replays those moments from your point of view
while OBS records them, and ffmpeg trims the recordings into clips and joins them into montages.

## One-time setup

1. **Install OBS Studio** (free): https://obsproject.com
2. In OBS, open **Tools → WebSocket Server Settings**, tick **Enable WebSocket server**, then click
   **Show Connect Info** and copy the password.
3. Start ClipMaker by double-clicking **`Start ClipMaker.bat`**. Go to **Settings → OBS Studio**,
   paste the password and click **Test & set up scene**. This creates a `CS2 ClipMaker` scene in OBS
   that captures the CS2 window and only CS2's audio, so Discord and music stay out of the clips.
4. Optional but recommended: in OBS **Settings → Output**, set the recording encoder to NVENC and the
   format to MKV or MP4. In **Settings → Video**, use 1920×1080 at 60 fps.

ffmpeg is already installed on this PC (`C:\ffmpeg`), and ClipMaker uses your NVIDIA GPU (NVENC) to
encode.

## Making clips

1. In CS2, download your matches from **Watch → Your Matches**. They appear in ClipMaker automatically.
2. Pick a match on the left. Highlights are pre-selected (the 2★-and-up ones), and you can tick or untick any.
3. Click **Record**. Keep OBS open and **don't touch the mouse or keyboard** while it records.
4. Your clips show up in the **Clips** tab, saved to `Videos\CS2 Clips`. Click clips in the order you
   want, then click **Create montage**.

## Automatic match downloads

The **Downloads** tab collects your matches from two places and saves new demos to CS2's `replays`
folder, under CS2's own file names:

1. **Steam Community match history.** These are your private Personal Game Data pages
   (`steamcommunity.com/my/gcpd/730/?tab=matchhistoryscrimmage`). This is the **only** place that
   lists **Scrimmage** and **Rush** replays. ClipMaker reads the Scrimmage, Rush, Premier, Competitive
   and Wingman tabs. Click **Sign in to Steam** once: it opens Steam's own login page in a separate
   window, so the app never sees your password. The sign-in is remembered, and **Sign out** clears it.
2. **Valve's recent-match list.** This goes through the Steam client already running on your PC,
   like CS2's Watch tab does. It only works while CS2 is closed, and Steam shows you as playing CS2
   for about 5 seconds during the check.

- The app checks every 30 minutes, or immediately when you click **Check now**. Steam Community is
  checked even while CS2 is open.
- Demos you already have under another name (for example `Jonas1.dem`) are recognized by map, number
  of rounds and players, so they aren't downloaded twice. This only works for demos the app has
  already analyzed in the Matches tab.
- A demo you deleted or moved after downloading is never downloaded again automatically. You can
  still click **Download again**.
- Valve deletes replays after a few weeks, so only recent matches can be downloaded.

## Background recording (default)

**Settings → Recording → Background — HLAE.** This mode doesn't need OBS, and you can keep using your PC
while it records.

- ClipMaker starts CS2 in a window through [HLAE](https://www.advancedfx.org/) 2.192.7, found in
  `%APPDATA%\cs2-clipmaker\hlae` or in the project's `tools\hlae`. It uses `-insecure` (no VAC servers) and `-afxFixNetCon` (so CS2's
  console port works on Windows), and sends commands over that port. CS2 never needs focus.
- HLAE's `mirv_streams` records frames straight from the game engine at a fixed frame rate (60 fps by
  default) and encodes them with your GPU. `mirv_cmd` starts and stops each recording on the exact demo
  tick. CS2 can stay behind other windows or be minimized; minimized, it renders more slowly.
- CS2 is **always closed** when the recording ends. Never use an HLAE/`-insecure` CS2 session to join
  matches.
- If recording fails right after a CS2 update, HLAE probably needs updating: download the latest
  version from advancedfx.org and point **Settings → Recording → HLAE folder** to it.

## How it controls CS2 (foreground / OBS mode)

On Windows, CS2's remote console only works in Workshop Tools mode. Instead, ClipMaker launches CS2
with `+exec clipmaker_init`, which binds **Scroll Lock** to `exec clipmaker_cmd`. To send a command,
the app writes it into `csgo/cfg/clipmaker_cmd.cfg` and presses Scroll Lock in the CS2 window.

- If CS2 is **already running** when you click Record, either type `exec clipmaker_init` in the CS2
  console once, or close CS2 and let ClipMaker start it.
- **Settings → Counter-Strike 2 → Test control** briefly opens and closes the CS2 console, which shows
  that control works.
- If you already use Scroll Lock in game, pick a different trigger key in Settings.

## If something looks off

| Problem | Fix (Settings → Advanced) |
| --- | --- |
| Clips show a loading screen or the wrong moment | Increase **Demo load wait** (large demos take longer to load) |
| Clips start mid-action or show a freeze | Increase **Seek wait** |
| Wrong player's view | Edit the **Spectate command** (`{accountid}` and `{name}` are filled in) |
| The demo skips but doesn't stay paused | Try the seek command `demo_goto {tick} 0 1` |
| Clips cut long pauses during clutches | Raise **Cut gaps longer than** (e.g. 60s) |

Demos from brand-new game modes (e.g. `rush_001` maps) can't be read yet by the demo parser.

## Demo parser (Rush support)

The official `@laihoe/demoparser2` (0.42.0) can't read Rush (`rush_001`) demos. ClipMaker ships its own
build in `vendor/demoparser2/`: upstream master `45ca85a` plus `rush-fixes.patch`. The patch makes two
changes:

1. Serializers are looked up by name **and version**, since Rush maps send several versions of
   `CBodyComponentBaseModelEntity`.
2. `qangle_precise` fields with a bit count of 32 (the full-precision version that Rush's conveyor
   belts use) are decoded as 3 raw floats.

On all 53 non-Rush demos tested, the output is byte-for-byte identical to the npm package, and all 10
Rush demos parse. `src/lib/parser.js` loads the vendored build and falls back to the npm package if it
is missing; set `CLIPMAKER_PARSER=npm` to force the npm package.

To rebuild it: install Rust, clone LaihoE/demoparser, apply the patch, make
`src/csgoproto/build.rs` an empty `fn main() {}` (it needs `protoc` otherwise), remove
`features = ["voice"]` from `src/node/Cargo.toml`, then run `cargo build --release` in `src/node`. Copy
`target/release/laihoe_demoparser2.dll` to `vendor/demoparser2/demoparser2.win32-x64-msvc.node`.

## Project layout

```
src/main.js              Electron main process, IPC
src/lib/demo.js          Demo → rounds/rosters/kills (demoparser2, runs in a worker)
src/lib/highlights.js    Multi-kill / clutch / special-kill detection, clip segments
src/lib/cs2.js           Launching CS2, sending console commands (key press or netcon)
src/lib/obs.js           OBS WebSocket: scene setup, start/stop recording
src/lib/recorder.js      Playback + recording orchestration
src/lib/ffmpeg.js        Trim, join, montage, thumbnails
src/renderer/            UI
```

Run from a terminal with `npm start`.
