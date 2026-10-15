# CS2 DemoLab

A lab for your CS2 demos, all on your PC: stats, replays, lineups and highlight clips. It reads each
demo once and shows an **overview dashboard** of your play (K/D, rating, clutches, opening duels, maps,
weapons, teammates), a **scoreboard, duels, heatmap, 2D replay and integrity check** for every match,
**zoomable per-map heatmaps** of kills, deaths, damage and grenades across all your matches, and a
**Utility** library for the grenade lineups you want to remember. It also finds your **multi-kills
(3K/4K/ace)**, **clutches** and **special kills** (no-scopes, wallbangs, through smoke, while flashed,
knife, Zeus, collaterals) and records them as clips: CS2 replays those moments through
[HLAE](https://www.advancedfx.org/), which records them in the background, and ffmpeg turns the
recordings into clips and montages.

## Setup

### With the installer

Run **`CS2-DemoLab-Setup-<version>.exe`**. It installs DemoLab for your Windows account (no admin
rights), with ffmpeg included, and adds Start menu and desktop shortcuts. You still need **Steam** and
**CS2**, and the **[Visual C++ Redistributable x64](https://aka.ms/vs/17/release/vc_redist.x64.exe)**
(usually already installed by Steam games). Then do step 2 below (Install HLAE).

The installer is on the [releases page](https://github.com/Ze-Chr0ME/demo_lab/releases). An installed
DemoLab keeps itself up to date (see [Updates](#updates)).

To build the installer yourself: `npm install --no-save electron-builder@26`, then `npm run dist`. It
copies the ffmpeg and ffprobe DemoLab finds on your PC into the installer and writes it to `dist\`.

### From the source

You need:

- **Windows 10/11 (64-bit)** with **Steam** and **CS2** installed (start CS2 once so its folders exist).
- **[Node.js](https://nodejs.org) 22.12+** (LTS).
- **ffmpeg** with `ffprobe`, for example the
  [gyan.dev essentials build](https://www.gyan.dev/ffmpeg/builds/) or `winget install Gyan.FFmpeg`.
  DemoLab looks for it on your `PATH`, in `C:\ffmpeg\bin` and in `C:\ffmpeg`. Anywhere else, set it
  in **Settings → Output → ffmpeg**. `ffprobe.exe` has to sit next to `ffmpeg.exe`.
- **[Visual C++ Redistributable x64](https://aka.ms/vs/17/release/vc_redist.x64.exe)**, used by the
  demo parser (usually already installed by Steam games).

Then:

1. Double-click **`Start DemoLab.bat`**. The first launch runs `npm install` and downloads Electron,
   which takes a few minutes. You can also run `npm install` and then `npm start` from a terminal.
2. In **Settings → Recording**, click **Check for updates → Install HLAE**. DemoLab downloads
   [HLAE](https://www.advancedfx.org/) into `%APPDATA%\cs2-demolab\hlae`. If an antivirus
   quarantines it (HLAE injects into CS2), restore it or add an exclusion for that folder.
3. The status panel at the bottom left should show CS2, Steam, ffmpeg and HLAE in green.

DemoLab used to be called CS2 ClipMaker. On its first start it moves `%APPDATA%\cs2-clipmaker` to
`%APPDATA%\cs2-demolab`, so parsed demos, settings, HLAE, the Steam sign-in and lineups carry over.

## Overview

The app opens on the **Overview**. On the left, your ≈ HLTV 2.0 rating with a breakdown (win rate, K/D,
ADR, KAST, HS%) and your last 10 results. On the right, twelve stat tiles (K/D, ADR, KAST, HS%, kills,
deaths and assists per round, opening duels, multi-kill rounds, trades, utility damage, enemies flashed),
each with a histogram of that stat over your matches: the dashed line is the whole selection, the solid
one your last 10 matches. Below: rating per match, your last matches, clutches per 1v1…1v5, opening duels
and rounds won per side, multi-kills, maps, weapons and the teammates you play with most. Filter it by
mode (5v5, Wingman, Rush), map and period. Click a result, a recent match or a point on the chart to open
that match, or a map to open it in **Maps**.

**Compare** (on the Overview, or in the top bar) puts you next to any player from your demos, or next to
**your lobbies**: the median of every player in every demo you have. Each stat shows how many of your
lobbies' player-matches it beats, so a 1.10 rating reads as "better than 68%". **Only your shared
matches** compares two players on the same games. Aim numbers are ranked from your lobbies' quartiles.

## Death review

Every death is checked for what went wrong, and the Overview adds them up (**Deaths**; click a line for
those deaths across your matches, each one opens in its match's 2D replay):

- **Died alone**: not traded, and no living teammate within 1,100 units, so nobody could trade you.
- **Not traded**: a teammate was close, but nobody killed your killer within 5 seconds.
- **Grenades unused**: you died with grenades in hand.
- **Entry without utility**: the first death of a T round, without a team grenade landing near the fight.
- **Caught off guard**: the killer came into view with your crosshair 15° or more from their head, hit
  first and killed you (about the worst quarter of engagements in your lobbies). Measured matches only.
- **Fought on low HP**, **Died blind**, **Team-flashed**, **After the round** (a saved gun lost).

Some tags only describe the fight: **Out-aimed** (your crosshair was close, they were faster),
**Crossfire**, **Never saw them**, **Hit first, lost** and **Opening death**. The **Deaths** tab of a
match lists that match's deaths with these tags, the killer, the weapon and the callout, and opens each
one in the 2D replay or in CS2. The thresholds were checked on 1,015 deaths from 14 of your matches. The
positions it needs are read once per demo (about a second); older demos get them in the background.

## Themes

**Theme** (in the menu under your name, top right) changes the colors and the backdrop behind every page, which moves as you scroll:

- **Teams** (HLTV's top 15 first: Spirit, Vitality, MOUZ, FURIA, Falcons, Aurora, Legacy, G2, FUT, NAVI,
  PARIVISION, MIBR, BetBoom, Astralis, FaZe; then The MongolZ, Liquid, paiN, 3DMAX, Virtus.pro, HEROIC,
  NiP, Fnatic, ENCE, Cloud9, Eternal Fire, TYLOO): the team's logo
  as a neon sign over a pattern. Flat logos are drawn as neon tubes; shaded or detailed ones (The MongolZ, ENCE)
  light up in the team color inside a neon outline, so they stay recognizable. Scrolling makes the
  pattern drift and the logo rise, tilt and dim.
- **Maps** (Dust II, Mirage, Inferno, Nuke, Ancient, Anubis, Overpass, Vertigo, Train, Cache, Office,
  Italy): a screenshot of the map. It slides up more slowly than the page and blurs as you scroll so
  cards stay readable. Pick any of the 4–6 angles CS2 has for the map.
- **DemoLab**: the app's own colors with a subtle pattern.
- **Your own**: background, accent and highlight colors, plus any map picture or any of the ~145 team
  logos CS2 ships, and a pattern.

Logos and screenshots are read from your CS2 install (`pak01_dir.vpk`, see `src/lib/themeArt.js`)
and cached in `%APPDATA%\cs2-demolab\theme-art`. Nothing is downloaded. Without CS2, map themes fall
back to the radar image.

## Aim

**Aim** is the match **Weapons** tab over all your matches at once: per weapon your kills, HS %, damage,
accuracy, kill types (wallbangs, through smoke, no-scopes…) and where your bullets land on the body, with
filters for mode, map, period, side and weapon type. Click weapons to compare them. Opened from the
Overview of another player (player search), it shows theirs. Each match is added up once and kept.

## Maps

**Maps** lists every map you have demos of, with your record on it. Open one to see all of its matches
on a single radar: kill and death locations, shots, damage dealt and taken, and smokes, flashes, HEs
and molotovs, for **you** or for **everyone** in those matches, T side, CT side or both. **Dots** shows
every single position and **Throw lines** connects each grenade to where it was thrown from (handy for
lineups). Next to it: your win rate, rating, K/D, ADR and round win rate per side on that map, and your
matches there.

All radars (Maps, a match's heatmap and its 2D replay) zoom with the **mouse wheel** towards the cursor,
**drag** to move around, and **double-click** (or the ⤢ button) shows the whole map again.

The interface scales itself to the window: on a 2560 × 1440 screen everything is drawn about 30% larger
than on 1920 × 1080, on 3840 × 2160 (100% display scaling) about 80%, and the pages spread their cards over
the extra room instead of leaving it empty. **Theme → Display** can set the size by hand.

## Making clips

1. In CS2, download your matches from **Watch → Your Matches** (or let the **Downloads** tab do it,
   see below). They show up in DemoLab automatically.
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
- **Deaths**: the point-of-view player's deaths, tagged (see **Death review**).
- **Heatmap**: where the selected player got kills, died, shot from, dealt or took damage, and where
  their grenades landed, split into T side and CT side like csstats.gg. It can show this match or every
  analyzed match on the same map. Nuke, Train and Vertigo have a floor switch, and Rush zooms to one room.
- **2D Replay**: a 2D replay of each round with players, view directions, health, weapons, smokes, fires,
  flashes, HE grenades, the bomb and a kill feed (Space: play/pause, ←/→: 5 seconds, ↑/↓: round). The
  first time you open a match's replay, its player positions are read, which takes a few seconds.
- **Integrity**: red flags for cheating, per player, with the moments behind them (each opens in the
  2D replay or in CS2 in that player's eyes). Not proof: moments worth watching. "Unknown" enemies below
  are behind a wall, not seen by anyone on the team or on the radar for 2 s, and silent (no footsteps or
  shots within earshot). It checks:
  - *No-mouse aim*: the view snaps onto an enemy and the player fires, while the demo's recorded mouse
    movement can't account for the turn (aim assistance writing view angles directly).
  - *Tracked through walls*: the crosshair follows an unknown enemy behind a wall.
  - *Aim behind walls*: how often the crosshair rests on unknown enemies, compared with the lobby.
  - *Pre-aimed appearances*: how often the crosshair is already on an unknown enemy the moment they come
    into view, compared with the lobby.
  - *Wall hits*: hits through walls on unknown enemies.

  Thresholds come from 532 player-matches; about 1 in 70 normal players gets "unusual". Who could see
  whom is computed against each map's collision mesh from [awpy-data](https://github.com/pnxenopoulos/awpy-data)
  (57 MB, downloaded once to the app's data folder the first time the tab is opened and checked against
  the release's sha256; the meshes are derived from Valve's map files). Without it (offline, a map that
  isn't covered) the game's radar spotting is used instead, which lags behind quick peeks. Smokes and
  doors are not taken into account. The first time a match's Integrity tab is opened, every tick is
  read (under a minute). Information-only cheats (a radar hack used to decide where to play) usually
  don't show in a single match.
- **Highlights & clips**: the clips to record (see above).

To give a match a name in DemoLab, double-click it in the list or click the pencil next to its
title. The file keeps its own name.

### Each demo is read only once

Demos are recognized by their content (size plus a hash of the first and last 256 KB), not by their
file name. Renaming, moving or copying a demo, or a changed file date, never makes DemoLab read it
again. The results are stored in `%APPDATA%\cs2-demolab\demo-data` along with custom names and demos
that couldn't be read. The stored data is raw facts (kills, damage, shots, grenades with positions), and
the stats are computed from it when shown, so a new stat or a formula change doesn't require reading
the demos again. Demos are re-read only when a DemoLab update changes what is extracted from them.

The radar images come from CS2's own files and are bundled in `src/renderer/radar`. After Valve changes
a map, regenerate them with `node scripts/extract-radars.js <Source2Viewer-CLI.exe> <...gamecsgo>`
(Source2Viewer's `cli-windows-x64.zip` from
[its releases](https://github.com/ValveResourceFormat/ValveResourceFormat/releases)).

## How recording works

- DemoLab starts CS2 in a window through HLAE with `-insecure` (no VAC servers) and `-afxFixNetCon`
  (so CS2's console port works on Windows), and sends commands over that port. CS2 never needs focus.
- HLAE's `mirv_streams` records frames straight from the game engine at a fixed frame rate (60 fps by
  default) and encodes them with ffmpeg. `mirv_cmd` starts and stops each recording on the exact demo
  tick.
- CS2 is **always closed** when the recording ends. Never use an HLAE/`-insecure` CS2 session to join
  matches.
- HLAE has to match the installed CS2 version. DemoLab checks for new HLAE releases at startup and
  every 6 hours, and shows a notice when one is available. After a CS2 update, install it from
  **Settings → Recording**.
- Resolution and frame rate are set in **Settings → Recording**. HLAE is looked for in
  `%APPDATA%\cs2-demolab\hlae`, then in the project's `tools\hlae`. **Browse** points to another
  folder.

## Automatic match downloads

The **Downloads** tab collects your matches from two places and saves new demos to CS2's `replays`
folder, under CS2's own file names:

1. **Steam Community match history.** These are your private Personal Game Data pages
   (`steamcommunity.com/my/gcpd/730/?tab=matchhistoryscrimmage`). This is the **only** place that
   lists **Scrimmage** and **Rush** replays. DemoLab reads the Scrimmage, Rush, Premier, Competitive
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

## New matches

A demo that arrives while DemoLab is open (from the Downloads tab, from CS2's Watch tab or copied into
a demo folder), or that arrived since DemoLab last ran, is read and measured straight away. A Windows
notification then sums it up: score, your K–D, rating and ADR, the highlights to clip and your most
common death mistake. Click it to open the match. While CS2 is running this runs at below-normal
priority on fewer cores. **Settings → New matches** turns it, the measuring or the notification off.
When DemoLab runs from the source instead of the installer, Windows may not show the notification; the
taskbar button flashes either way.

## Utility

**Utility** keeps the grenade lineups you want to remember: where to stand, where to aim, how to throw,
pictures, and a practice quiz. **Share** on a lineup (or **Share these** for the whole list shown) copies
it as one line of text starting with `DLU1-`, about 250 characters per lineup with its flight path, to
paste in Discord or a chat. **Import code** reads one or more codes and shows what's in them before
adding anything; lineups you already have are skipped. Pictures stay on your PC.

## If something looks off

| Problem | Fix |
| --- | --- |
| "CS2 is already running normally" | Close CS2 completely (check the Steam library says it isn't running), then click Record again |
| CS2 opens but never starts recording, or crashes right after a CS2 update | Update HLAE in **Settings → Recording** |
| The first clip fails right after CS2 opens | Raise **CS2 startup wait** in **Settings → Advanced timing & commands** |
| "HLAE did not produce a video file" | Check the ffmpeg path in **Settings → Output** |
| Clips cut long pauses during clutches | Raise **Cut gaps longer than** in **Settings → Highlights** (e.g. 60s) |
| Steam Community sign-in doesn't stick | Look at `%APPDATA%\cs2-demolab\demolab.log` |

Demos from game modes that are newer than the demo parser may not be readable.

## Updates

An installed DemoLab looks for a new [GitHub release](https://github.com/Ze-Chr0ME/demo_lab/releases)
when it starts and every 6 hours, and downloads it in the background (checked against the sha256 GitHub
lists for the file). An **Update** button then appears in the top bar: it restarts DemoLab into the new
version. If you don't click it, the update installs when you close DemoLab. Matches, settings, lineups and
the install folder are kept. **Settings → Updates** shows the release notes, has "Check now", and turns the
automatic check off. Run from the source, DemoLab only reports new releases: update with `git pull`.

To publish a release: raise `version` in package.json, commit and push, then run `npm run release`
(notes generated from the commits) or `npm run release -- notes.md`. It builds the installer and uploads
it to a new `v<version>` release with the GitHub CLI (`gh`), so installed copies pick it up.

## Demo parser (Rush support)

The official `@laihoe/demoparser2` (0.42.0) can't read Rush (`rush_001`) demos. DemoLab ships its own
build in `vendor/demoparser2/`: upstream master `45ca85a` plus `rush-fixes.patch`. The patch makes two
changes:

1. Serializers are looked up by name **and version**, since Rush maps send several versions of
   `CBodyComponentBaseModelEntity`.
2. `qangle_precise` fields with a bit count of 32 (the full-precision version that Rush's conveyor
   belts use) are decoded as 3 raw floats.

On all 53 non-Rush demos tested, the output is byte-for-byte identical to the npm package, and all 10
Rush demos parse. `src/lib/parser.js` loads the vendored build and falls back to the npm package if it
is missing or can't be loaded (for example without the Visual C++ runtime); set `DEMOLAB_PARSER=npm`
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
src/lib/rounds.js        Money, loadouts, callouts per round; positions and grenades at each kill
src/lib/deaths.js        Death review: tags for every death
src/lib/utility.js       Utility lineups on disk, share codes
src/lib/track.js         Sampled player positions for the 2D replay
src/lib/integrity.js     Aim/visibility anomalies per player (Integrity tab) and their scoring
src/lib/geometry.js      Map collision meshes (awpy-data download) and line-of-sight ray casts
src/lib/parser.js        Loads the vendored demo parser (or the npm one)
src/lib/highlights.js    Multi-kill / clutch / special-kill detection, clip segments
src/lib/hlae.js          Starting CS2 through HLAE, console port, HLAE updates
src/lib/recorder.js      Playback + recording orchestration
src/lib/ffmpeg.js        Mux, join, montage, thumbnails
src/lib/matches.js       Match downloads (gcWorker.js: Valve's list, community.js: Steam Community)
src/lib/steam.js         Finding Steam, CS2 and the logged-in account
src/lib/updater.js       DemoLab's own updates from GitHub releases
src/renderer/            UI (radar/: bundled radar images and their world coordinates)
scripts/extract-radars.js  Regenerates src/renderer/radar from a CS2 install
scripts/dist.js          Builds the installer (npm run dist)
scripts/release.js       Publishes it as a GitHub release (npm run release)
```
