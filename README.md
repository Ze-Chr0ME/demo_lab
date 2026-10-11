# CS2 ClipMaker

Stats, replays and highlight clips from your CS2 demos, all on your PC. It reads each demo once and shows
an **overview dashboard** of your play (K/D, rating, clutches, opening duels, maps, weapons, teammates),
a **scoreboard, duels, heatmap and 2D replay** for every match, and **zoomable per-map heatmaps** of
kills, deaths, damage and grenades across all your matches. It also finds your **multi-kills
(3K/4K/ace)**, **clutches** and **special kills** (no-scopes, wallbangs, through smoke, while flashed,
knife, Zeus, collaterals) and records them as clips: CS2 replays those moments through
[HLAE](https://www.advancedfx.org/), which records them in the background, and ffmpeg turns the
recordings into clips and montages.

## Setup

You need:

- **Windows 10/11 (64-bit)** with **Steam** and **CS2** installed (start CS2 once so its folders exist).
- **[Node.js](https://nodejs.org) 22.12+** (LTS).
- **ffmpeg** with `ffprobe`, for example the
  [gyan.dev essentials build](https://www.gyan.dev/ffmpeg/builds/) or `winget install Gyan.FFmpeg`.
  ClipMaker looks for it on your `PATH`, in `C:\ffmpeg\bin` and in `C:\ffmpeg`. Anywhere else, set it
  in **Settings → Output → ffmpeg**. `ffprobe.exe` has to sit next to `ffmpeg.exe`.
- **[Visual C++ Redistributable x64](https://aka.ms/vs/17/release/vc_redist.x64.exe)**, used by the
  demo parser (usually already installed by Steam games).

Then:

1. Double-click **`Start ClipMaker.bat`**. The first launch runs `npm install` and downloads Electron,
   which takes a few minutes. You can also run `npm install` and then `npm start` from a terminal.
2. In **Settings → Recording**, click **Check for updates → Install HLAE**. ClipMaker downloads
   [HLAE](https://www.advancedfx.org/) into `%APPDATA%\cs2-clipmaker\hlae`. If an antivirus
   quarantines it (HLAE injects into CS2), restore it or add an exclusion for that folder.
3. The status panel at the bottom left should show CS2, Steam, ffmpeg and HLAE in green.

## Overview

The app opens on the **Overview**: your K/D and ≈ HLTV 2.0 rating (with how your last 10 matches compare),
clutch success per 1v1…1v5, recent results, win rate, HS%, ADR, KAST, opening duels per side, your maps,
a rating-per-match chart, your best weapons, multi-kills and utility, rounds won per side and the
teammates you play with most. Filter it by mode (5v5, Wingman, Rush), map and period. Click a recent
match or a point on the chart to open that match, or a map to open it in **Maps**.

## Maps

**Maps** lists every map you have demos of, with your record on it. Open one to see all of its matches
on a single radar: kill and death locations, shots, damage dealt and taken, and smokes, flashes, HEs
and molotovs, for **you** or for **everyone** in those matches, T side, CT side or both. **Dots** shows
every single position and **Throw lines** connects each grenade to where it was thrown from (handy for
lineups). Next to it: your win rate, rating, K/D, ADR and round win rate per side on that map, and your
matches there.

All radars (Maps, a match's heatmap and its 2D replay) zoom with the **mouse wheel** towards the cursor,
**drag** to move around, and **double-click** (or the ⤢ button) shows the whole map again.

The interface scales itself to the window: on a 2560 × 1440 screen everything is drawn about 20% larger
than on 1920 × 1080. **Settings → Display** can set the size by hand.

## Making clips

1. In CS2, download your matches from **Watch → Your Matches** (or let the **Downloads** tab do it,
   see below). They show up in ClipMaker automatically.
2. **Close CS2.** Recording needs its own CS2 session started through HLAE.
3. Open a match in **Matches** and go to its **Highlights & clips** tab. The 2★-and-up highlights are
   pre-selected, and you can tick or untick any.
4. Click **Record**. CS2 opens in a window and plays the demo. **You can keep using your PC**, and you
   can put other windows over CS2 or minimize it (it renders more slowly when minimized). CS2 closes
   by itself when recording finishes.
5. Your clips show up in the **Clips** tab and are saved to `Videos\CS2 Clips`. Click clips in the
   order you want, then click **Create montage**.

## Match stats

Each match opens on its scoreboard and has five tabs:

- **Scoreboard**: K/D/A, ADR, HS%, KAST and an **≈ HLTV Rating 2.0** for every player. **Detailed** adds
  opening kills/deaths, multi-kill rounds, clutches, trade kills, utility damage, enemies flashed and
  flash assists. HLTV doesn't publish its rating formula, so the rating uses the widely used community
  reconstruction, which is usually within about ±0.02 of HLTV's number. Click a column to sort it, or a
  player to view the match (heatmap, highlights) as them.
- **Duels**: who killed whom, for all kills or only each round's opening duel.
- **Heatmap**: where the selected player got kills, died, shot from, dealt or took damage, and where
  their grenades landed, split into T side and CT side like csstats.gg. It can show this match or every
  analyzed match on the same map. Nuke, Train and Vertigo have a floor switch, and Rush zooms to one room.
- **2D Replay**: a 2D replay of each round with players, view directions, health, weapons, smokes, fires,
  flashes, HE grenades, the bomb and a kill feed (Space: play/pause, ←/→: 5 seconds, ↑/↓: round). The
  first time you open a match's replay, its player positions are read, which takes a few seconds.
- **Highlights & clips**: the clips to record (see above).

To give a match a name in ClipMaker, double-click it in the list or click the pencil next to its
title. The file keeps its own name.

### Each demo is read only once

Demos are recognized by their content (size plus a hash of the first and last 256 KB), not by their
file name. Renaming, moving or copying a demo, or a changed file date, never makes ClipMaker read it
again. The results are stored in `%APPDATA%\cs2-clipmaker\demo-data` along with custom names and demos
that couldn't be read. The stored data is raw facts (kills, damage, shots, grenades with positions), and
the stats are computed from it when shown, so a new stat or a formula change doesn't require reading
the demos again. Demos are re-read only when a ClipMaker update changes what is extracted from them.

The radar images come from CS2's own files and are bundled in `src/renderer/radar`. After Valve changes
a map, regenerate them with `node scripts/extract-radars.js <Source2Viewer-CLI.exe> <...gamecsgo>`
(Source2Viewer's `cli-windows-x64.zip` from
[its releases](https://github.com/ValveResourceFormat/ValveResourceFormat/releases)).

## How recording works

- ClipMaker starts CS2 in a window through HLAE with `-insecure` (no VAC servers) and `-afxFixNetCon`
  (so CS2's console port works on Windows), and sends commands over that port. CS2 never needs focus.
- HLAE's `mirv_streams` records frames straight from the game engine at a fixed frame rate (60 fps by
  default) and encodes them with ffmpeg. `mirv_cmd` starts and stops each recording on the exact demo
  tick.
- CS2 is **always closed** when the recording ends. Never use an HLAE/`-insecure` CS2 session to join
  matches.
- HLAE has to match the installed CS2 version. ClipMaker checks for new HLAE releases at startup and
  every 6 hours, and shows a notice when one is available. After a CS2 update, install it from
  **Settings → Recording**.
- Resolution and frame rate are set in **Settings → Recording**. HLAE is looked for in
  `%APPDATA%\cs2-clipmaker\hlae`, then in the project's `tools\hlae`. **Browse** points to another
  folder.

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

## If something looks off

| Problem | Fix |
| --- | --- |
| "CS2 is already running normally" | Close CS2 completely (check the Steam library says it isn't running), then click Record again |
| CS2 opens but never starts recording, or crashes right after a CS2 update | Update HLAE in **Settings → Recording** |
| The first clip fails right after CS2 opens | Raise **CS2 startup wait** in **Settings → Advanced timing & commands** |
| "HLAE did not produce a video file" | Check the ffmpeg path in **Settings → Output** |
| Clips cut long pauses during clutches | Raise **Cut gaps longer than** in **Settings → Highlights** (e.g. 60s) |
| Steam Community sign-in doesn't stick | Look at `%APPDATA%\cs2-clipmaker\clipmaker.log` |

Demos from game modes that are newer than the demo parser may not be readable.

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
is missing or can't be loaded (for example without the Visual C++ runtime); set `CLIPMAKER_PARSER=npm`
to force the npm package.

To rebuild it: install Rust, clone LaihoE/demoparser, apply the patch, make
`src/csgoproto/build.rs` an empty `fn main() {}` (it needs `protoc` otherwise), remove
`features = ["voice"]` from `src/node/Cargo.toml`, then run `cargo build --release` in `src/node`. Copy
`target/release/laihoe_demoparser2.dll` to `vendor/demoparser2/demoparser2.win32-x64-msvc.node`.

## Project layout

```
src/main.js              Electron main process, IPC
src/lib/demo.js          Demo → rounds/rosters/kills/damage/shots/grenades (demoparser2, in a worker)
src/lib/store.js         Content-based demo ids, parsed data, failures and custom names on disk
src/lib/stats.js         Scoreboard (KAST, ≈Rating 2.0, trades, clutches…) and duels
src/lib/heat.js          Heatmap points per player (or everyone), grenades with their throw spot
src/lib/profile.js       Your per-match summary for the overview and the Maps page
src/lib/track.js         Sampled player positions for the 2D replay
src/lib/parser.js        Loads the vendored demo parser (or the npm one)
src/lib/highlights.js    Multi-kill / clutch / special-kill detection, clip segments
src/lib/hlae.js          Starting CS2 through HLAE, console port, HLAE updates
src/lib/recorder.js      Playback + recording orchestration
src/lib/ffmpeg.js        Mux, join, montage, thumbnails
src/lib/matches.js       Match downloads (gcWorker.js: Valve's list, community.js: Steam Community)
src/lib/steam.js         Finding Steam, CS2 and the logged-in account
src/renderer/            UI (radar/: bundled radar images and their world coordinates)
scripts/extract-radars.js  Regenerates src/renderer/radar from a CS2 install
```
