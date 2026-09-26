# Motion Fitness Game

[中文](README.md) · [English](README.en.md)

A small fitness game that uses an ordinary webcam for motion tracking: **20 exercises** split into five categories — **Upper body / Lower body / Core / Full body / Stretching**,
with a home page where you pick an exercise by category and start training right away; **rep exercises count reps automatically and timed exercises time themselves**,
and **scoring runs form step by form step** — every form step you hit instantly earns points, rings a chime, and is spoken aloud.

The interface ships in **中文 / English**, switchable any time from **⚙️ Settings** in the top-right corner (language, detection model, sound effects and background music all live in there).

It's pure front end: the MediaPipe pose model and wasm all live in the local `vendor/` directory, so **nothing goes online and no video is ever uploaded**.

---

## Table of contents

- [Feature highlights](#feature-highlights)
- [Requirements](#requirements)
- [Installation](#installation)
  - [Step 0: Get the code](#step-0-get-the-code)
  - [Step 1: Install Node.js](#step-1-install-nodejs)
  - [Install Node.js on Windows](#install-nodejs-on-windows)
  - [Install Node.js on macOS](#install-nodejs-on-macos)
  - [Install Node.js on Linux](#install-nodejs-on-linux)
  - [Don't want to install Node.js? Use Python instead](#dont-want-to-install-nodejs-use-python-instead)
- [Running and accessing the app](#running-and-accessing-the-app)
- [Camera permissions](#camera-permissions)
- [Home page and exercise page](#home-page-and-exercise-page)
- [🖐 Gesture rings after a set (exit / one more set)](#-gesture-rings-after-a-set-exit--one-more-set)
- [Settings modal (language / model / sound)](#settings-modal-language--model--sound)
- [Pre-workout calibration](#pre-workout-calibration)
- [How to use it (camera angle matters)](#how-to-use-it-camera-angle-matters)
- [Exercise library overview (20 exercises)](#exercise-library-overview-20-exercises)
- [Scoring rules](#scoring-rules)
- [Languages](#languages)
- [Can't fit into the outline or getting no response? Four checks](#cant-fit-into-the-outline-or-getting-no-response-four-checks)
- [FAQ](#faq)
- [Tests](#tests)
- [Project structure](#project-structure)
- [Tuning scores and thresholds yourself](#tuning-scores-and-thresholds-yourself)
- [Privacy and license](#privacy-and-license)

---

## Feature highlights

- **Exercise home page (five categories)**: you land on a wall of exercises split into **Upper body (1) · Lower body (6) · Core (6) · Full body (5) · Stretching (2)**,
  and each exercise is one card (icon + name + reps/timed + target + judging basis), with a search box as well. Click a card to open its exercise page, and the 🏠 icon in the top-left corner brings you back any time.
  “Jumping Jack” in Full body and “Butt Kick” under Lower body are both **timed counting**: a fixed 60 seconds to see how many reps you can do.
- **Exercise page + settings modal**: the exercise page has ⚙️ Settings in the top-right corner, and the modal collects **language, detection model, sound effects, spoken counting and background music**
  together with mirror, skeleton, angles and metrics toggles — no more hunting for buttons all over the screen.
- **Pre-workout calibration**: before you start there's a **dashed body silhouette** in the frame (it only traces your outer shape — you don't need to line up your joints), and a text prompt above the video tells you
  “move into the dashed outline”; **as long as a body is detected and your whole body is in frame you're cleared to start** (about 0.6 seconds), while
  distance, centering, height, camera angle and holding still are only recommendations (marked with “·” in the panel) and no longer block the start.
  The outline is hidden **the moment recognition succeeds** — it only exists to lead you into position, and it is never drawn during the
  countdown, the workout or a pause (see [Pre-workout calibration](#pre-workout-calibration)).
- **Form steps scored one at a time**: each exercise is broken into 4–5 judgeable steps — hit one and you immediately get points, a chime, and a checkmark;
  finishing every step in a round earns a perfect-round bonus, and hold exercises give **+1 point for every second you hold**.
- **The keyframes are the only criteria**: every exercise is split into 4–5 keyframes on the progress bar — **clear one and it lights up and scores**;
  **clearing all of them counts one rep**. There is no strict mode and no separate “counting rule” any more: both the criteria and the
  points hang off the keyframes (`tests/test-specs.mjs` checks, exercise by exercise, that “the chain finished” and “a rep was counted” happen on the same frame).
- **Timed counting (Jumping Jack, Butt Kick)**: **a fixed 60 seconds to see how many reps you can fit in** — the rep rule is untouched, only
  “when the set is done” moves from “reach the rep target” to “the time is up”. The screen shows `⏱ 42 / 60 s left`, the remaining
  45/30/15/5 seconds are spoken aloud, and the moment time is up the clock stops and the set is saved
  (**52 reps / 60 s**). Change the duration (30–120 s) in 🎯 exercise settings.
  See [Timed counting](#timed-counting-jumping-jack--butt-kick-a-fixed-60-seconds-see-how-many-you-can-do).
- **Valid rep detection (one relaxed tier only)**: **if you roughly did the movement, it counts** — shallower squats and lunges, push-ups that only go part of the way down and glute bridges that don't rise very high all count, while the voice coach corrects “go lower / down a little more / lift your hips higher / don't let your lower back sag” and the score is discounted for quality. Movements you didn't really do (a mere wobble) aren't counted and won't trigger nagging.
- **Every exercise states its “judging basis”**: the card and the exercise page spell out what the exercise is judged by (elbow bend / knee bend /
  hip lift height / both feet off the floor / body posture …), and exercises the camera can't judge reliably are additionally marked as **rough scoring**.
- **Live status feedback**: the area below the video always shows what state you're in, which step you're stuck on, and how many degrees you still need.
- **🐞 Metrics panel (with “Rep diagnosis”)**: besides the raw numbers (view, visibility, joint angles), the first line is a **rep diagnosis** —
  which stage the detector is in, the line it needs you to come back to for a rep to count, this rep’s minimum/peak, and **why the last attempt was not counted**
  (too shallow / too fast / too little range …). If counting looks wrong, read that line out and we can pinpoint it instead of guessing.
  **Left/right alternating exercises (butt kick / mountain climber / dead bug) got their own diagnosis rows too**: both legs' current
  readings (the active one carries a ✓), the alternation lines (enter / exit), which side is currently recognised, and how long ago the
  last rep was counted — that is how the “fast kicks do not count” report was traced down.
- **Spoken counting in the selected language + sound effects**: hitting a form step plays a rising chime and the first time you hit a step it is spoken aloud. **The voice never reads the score** (the user asked for reps and seconds only) — when you cross
  another 50 points it says an **encouragement** instead, and the score lives on screen (HUD, set summary, history).
- **Motivation first, guidance moderate**: **every rep is spoken aloud**, every 3 reps you get an **encouragement**
  (**a rotating pool of 24**: “Keep going / Great job / Excellent / Beautiful / Right on rhythm / You are crushing it / So much grit /
  Getting smoother …”), hitting your target celebrates you before adding another cheer, a **round with every keyframe cleared** earns an
  extra shout (“Perfect! / Full marks, beautiful …”), and a **set ending** says “that set: N reps” plus a cheer (“great work, give
  yourself a pat on the back …”, again with no score);
  **very fast exercises are the exception** (the jumping jack and the butt kick — “a jack takes about 0.6 s per rep, a butt kick
  lands about two per second”, so counting every rep is both unintelligible and disruptive): they (`speakEvery: 5` in `catalog.js`)
  **speak the count only every 5 reps**, the encouragement drops to the same every-5 rhythm, and the counting frame never also says
  an encouragement (two lines in one frame cancel each other out);
  form corrections are kept but run much less often (the same line is not repeated within 15–30 s, and less often once you are a few reps in), and “what comes next” is slowed to one line every 9 s
  — the airtime goes to counting and encouragement, so you barely need to watch the screen.
- **🎶 Four selectable background tracks**: all synthesised live (no space taken, no internet needed) — pick one under “🎵 Background track” in the settings:
  **City Run** (132 BPM, light and swinging) / **Neon Pulse** (144 BPM, four-on-the-floor electronic) / **Sunrise Funk** (122 BPM, funky syncopation) / **Power Drive** (152 BPM, driving rock).
  The drum kit is really synthesised (kick, snare, hats, claps), so the rhythm is much punchier than before, and the music ducks automatically while the coach is speaking.
- **🦴 Skeleton toggle**: hide the skeleton overlay and keep just the camera view; the **angle labels** toggle independently —
  with them on, the app prints **the one angle that exercise is actually judged by** (knee/hip for the squat, elbow for the
  push-up, and **“Hip”** — the torso-to-leg angle — plus the knee for the lying leg raise), so you can see how far you
  are from the line while you move. Exercises judged by something that is not a joint angle (jumping jack, burpee, the jump
  family) print nothing, so the picture never fills up with numbers.
  **The skeleton colour is the “am I good right now?” signal** (`app.js` picks a status every frame and `render.js` maps it through
  `COLORS`):
  - **Teal** (`ok`, the default): a person is tracked and judging is running normally (the posture gate passed), with no correction
    spoken in the last 2 seconds — keep doing what you are doing;
  - **Amber** (`warn`) covers two cases: ① **you are not yet in the posture this exercise requires** (`det.active === false`, so
    judging is paused and the hint bar below tells you what is missing, e.g. “lie down first”); ② **a correction was spoken within
    the last 2 seconds** (`now - state.lastCueAt < 2000`) — it stays amber for those 2 seconds even after you fix it, pointing at
    what was just said, then turns teal again by itself;
  - **Grey** (`idle`): this frame **was not accepted as a valid person** (`frame.ok === false`; the exact rules live in the
    constants at the top of `src/metrics.js`): the 12 core joints (shoulders / elbows / wrists / hips / knees / ankles) average a
    visibility of ≤ 0.10, or **three or more** of the 15 judging points are invisible (visibility ≤ 0.02), or the **torso length
    drops to ≤ 2% of the frame height** (all landmarks collapsed onto one point — the degenerate frames you get just before
    tracking is lost). Typical causes: you moved out of frame, you are too far from the camera, the room is too dark or back-lit, or
    large parts of the body occlude each other. Grey is **not an error** — it recovers as soon as you are back in frame; only when
    nobody is found at all does the skeleton **disappear entirely** (instead of turning grey), and the status bar speaks “no person
    found”.
    > These thresholds were **loosened** after user feedback (they used to be “average ≤ 0.16, or any single landmark ≤ 0.03”):
    > raising both hands out of frame, a foot leaving the picture, or the face and fingers being hidden all still count as “person
    > detected” (the face and fingers never take part in judging), and a dimly lit room is tolerated down to an average visibility of
    > 0.10. In exchange, a new “torso length must not collapse” rule keeps the degenerate frames out.
  - Note: the **dashed calibration silhouette** has its own three colours (bright sky-blue = nobody found yet, bright amber =
    adjusting, bright green = in position but not yet held for 0.6 s) — a different set from the skeleton's three.
    **Roughly 0.6 s after it turns green the whole outline disappears** (you've been recognised), so you never see it mid-workout.
- **The screen also shows “Trunk xx°” (the trunk tilt)**: as the user asked — “show the trunk tilt in degrees on screen, the same
  way ‘Hip’ and ‘Knee’ are shown” — every one of the **17 exercises** that prints joint angles (the standing / plank / lying /
  kneeling exercises whose criteria are angles) also gets a **trunk tilt** label. It is drawn **exactly like “Hip” and “Knee”**
  (dark pill plus degrees, flipped together with the mirror view, and hidden together with the angle toggle) and it is anchored at
  the **middle of the torso, pushed out perpendicular to the torso** (beside the trunk when you stand, above the body when you lie
  down), so it never stacks on top of the other labels.
  > **The seated forward fold now shows angles too (the user reported “it shows no angle”)**: it used to belong to the “criteria are
  > not joint angles, so print nothing” group — yet what it judges *is* the fold depth (the `seatedFold` gate requires “trunk tilt
  > ≥ 40°” plus hips ≤ 0.9 off the floor). It now prints **“Hip xx°”** (the torso-to-leg angle: about 90° sitting tall, about 40°
  > folded all the way) and **“Trunk xx°”** (40° is the line it is judged against), so you can watch the depth live. The **standing**
  > forward fold (judged on trunk tilt ≥55° + hips ≤0.65) still prints nothing for now — one line would add it the same way.
- **With both legs in frame, the two knees are labelled separately** (the user asked: “when both legs are on screen, show the left
  and right knee angles separately”): the screen then reads **“Left knee xx°”** and **“Right knee xx°”**, each measured on its own
  side — for criteria like the lunge's “both knees must bend” you can see at a glance which leg is lagging. When only one leg is
  clearly visible (the far leg hides behind the torso in a side view) it falls back to a single neutral **“Knee xx°”** rather than
  guessing a side. “Both legs in frame” is the detector's own `frame.legsVisible` (hip-knee-ankle visibility above 0.16 on both
  sides) — the very same condition the 🐞 panel shows as “Both legs visible”. If the two labels would land almost on top of each
  other (standing side-on), one is automatically lifted a row so they never merge into a blob.
- **The plank also prints “Shoulder xx°” and “Elbow xx°”** (the user reported “it never times; judge it by the joint angles”):
  “Shoulder” is the **shoulder joint angle (hip-shoulder-elbow)** — the very angle that now decides whether the clock runs
  (forearm plank ≈78°, lying flat resting ≈10°) — and “Elbow” shows whether you are on your forearms (≈90°) or your hands
  (≈175°). Together with “Hip” and “Trunk” that is all four numbers the user described, on screen.
- **The jumping jack shows “Spread 0.83” on screen**: its criterion is not a joint angle but the **leg spread** (whichever is
  wider, knees or ankles, in torso lengths), so that is what the label reports — same pill, flipped together with the mirror view,
  right between your legs. The user asked “why does the jumping jack have no angle?”: because it is not judged by one (only the
  angle-based exercises get a “Knee 132°”-style label). Reference values: **≥ 0.66 counts, ≤ 0.54 closes the rep**.
- **Goal progress ring + two record icons 🏆 / 📜**: **best scores** (your best set per exercise) and **workout history** (the last
  12 sets) both live in **modals opened from the top bar**, no longer taking up room on the exercise page (the user asked for that);
  the data is stored locally in your browser.
- **Works offline**: the model and wasm are local files, so it runs with no internet at all — and no video is ever uploaded.

---

## Requirements

| Item | Requirement |
|---|---|
| Operating system | Windows 10/11, macOS 11+, or any mainstream Linux desktop distribution |
| Browser | Chrome / Edge 91+, Safari 16.4+, Firefox 89+ (WebAssembly SIMD support required) |
| Camera | A built-in laptop camera or a USB webcam — 720p or better recommended |
| Node.js | **Optional.** The bundled `preview-server.js` needs Node 18+; if you'd rather not install Node, Python works too |
| Network | **Only needed to get the code**; running and tracking are entirely offline |

---

## Installation

### Step 0: Get the code

**Option A: Download the ZIP (recommended if you'd rather not wrestle with git)**

1. Open <https://github.com/playteka/motion-fitness-game>
2. Click the green **Code** button → **Download ZIP**
3. Unzip it anywhere, for example `C:\Users\your-username\motion-fitness-game` (Windows) or `~/motion-fitness-game` (macOS / Linux)

**Option B: Clone with git**

```bash
git clone https://github.com/playteka/motion-fitness-game.git
cd motion-fitness-game
```

> The repo already ships MediaPipe's wasm and pose model (about 33MB), so you **don't** need to run any dependency-installation step — there is no `npm install`.

### Step 1: Install Node.js

You only need Node to run the bundled local static server (a dozen or so lines of code). **Skip this if you already have it** — check with `node -v`:

```bash
node -v      # needs v18 or newer; v20/v22 both work
```

---

### Install Node.js on Windows

**Option 1: winget (built into Windows 10 1809+ / Windows 11, and the least hassle)**

Open **PowerShell** (search for "PowerShell" in the Start menu) and run:

```powershell
winget install OpenJS.NodeJS.LTS
```

**Option 2: The official installer**

1. Open <https://nodejs.org/> → download the **LTS** **Windows Installer (.msi)** (64-bit)
2. Double-click it and click Next all the way through; **leave "Add to PATH" checked**
3. When it's done, **close PowerShell / Command Prompt and open it again**

**Verify:**

```powershell
node -v
npm -v
```

If both print a version number (for example `v22.14.0` / `10.9.2`), you're set.

> If you get "the term 'node' is not recognized as the name of a cmdlet", PATH hasn't taken effect: close the terminal and reopen it. If that doesn't help, reinstall and make sure Add to PATH is checked.

---

### Install Node.js on macOS

**Option 1: Homebrew (recommended)**

If you don't have Homebrew yet, first run the command from the official site in “Terminal” (<https://brew.sh>):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Then:

```bash
brew install node
```

**Option 2: The official installer**

1. Open <https://nodejs.org/> → download the **LTS** **macOS Installer (.pkg)**
2. Double-click it and keep clicking Continue
3. Open “Terminal” to verify

**Verify:**

```bash
node -v
npm -v
```

> Apple silicon (M-series) and Intel Macs can both use the universal installer from the official site; Homebrew automatically installs the build for your architecture.

---

### Install Node.js on Linux

**Debian / Ubuntu / Linux Mint**

The version in the distro repositories is usually too old, so the NodeSource LTS repository is recommended:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

**Fedora / RHEL / CentOS**

```bash
sudo dnf install -y nodejs
```

**Arch / Manjaro**

```bash
sudo pacman -S nodejs npm
```

**openSUSE**

```bash
sudo zypper install nodejs20
```

**The universal route: nvm (works on any distribution, and needs no sudo)**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# open a new terminal, or run: source ~/.bashrc
nvm install --lts
```

**Verify:**

```bash
node -v
npm -v
```

> **Camera permissions (Linux-specific)**: make sure the device exists and that you have read/write access
> ```bash
> ls -l /dev/video*
> ```
> If the device is owned by `root:video`, add yourself to the video group and then **log in again**:
> ```bash
> sudo usermod -aG video $USER
> ```
> Browsers can use the camera just fine on `http://127.0.0.1` (localhost counts as a secure context), so no extra configuration is needed.

---

### Don't want to install Node.js? Use Python instead

This project is really just a **static web page**, so any static server can host it. macOS and most Linux distributions ship with Python 3:

```bash
cd motion-fitness-game
python3 -m http.server 4174 --bind 127.0.0.1
```

On Windows, if you have Python installed, swap `python3` for `python`:

```powershell
cd motion-fitness-game
python -m http.server 4174 --bind 127.0.0.1
```

> ⚠️ You need **Python 3.9 or newer**: older versions don't serve `.wasm` files with the correct `application/wasm`
> MIME type, and the browser will refuse to load the pose model. If you don't have a recent Python, Node is the easier route.

---

## Running and accessing the app

**With Node (recommended):**

```bash
cd motion-fitness-game
node preview-server.js
```

You should see these two lines (the script prints one in Chinese and one in English):

```
体感健身游戏预览地址： http://127.0.0.1:4174
Motion Fitness is running at: http://127.0.0.1:4174
```

**With Python:** see the section above — same port 4174.

Then open this in your browser:

### 👉 <http://127.0.0.1:4174>

The first time in, click “Start camera” → choose “Allow” in the browser prompt → pick an exercise → **move into the dashed body outline on screen**;
the moment your whole body is recognised (the dashed outline disappears), the 3-2-1 countdown fires automatically and counting begins.
**Once you are in the workout state (countdown / counting / paused) the dashed outline never comes back.**

> ⚠️ **Don't just double-click `index.html`**. When you open it over `file://`, the browser blocks the camera and the wasm load,
> so you have to go through `http://127.0.0.1:...` (localhost counts as a secure context).

**Changing the port / letting other people connect**

```bash
# Windows PowerShell
$env:PORT=8080; node preview-server.js

# macOS / Linux
PORT=8080 node preview-server.js
```

By default the server only listens on `127.0.0.1` (local machine only) — that protects your privacy and keeps other people on the same network from connecting to it.

---

## Camera permissions

### Windows

1. **Settings → Privacy & security → Camera**
   - Turn on “**Camera access**”
   - Turn on “**Let apps access your camera**”
   - Scroll down to “**Let desktop apps access your camera**” and make sure it's on
2. In the browser, click the 🔒 / camera icon to the left of the address bar → set “Camera” to **Allow**, then refresh the page
3. The first time you run `node`, Windows Firewall may pop up: since it only listens on 127.0.0.1, **allowing or canceling makes no difference either way**

### macOS

1. The first time you click “Start camera”, the browser shows a system permission dialog → click “**Allow**”
2. If you clicked “Don't Allow” by mistake earlier: **System Settings → Privacy & Security → Camera** → check your browser (Chrome / Safari / Edge), then **quit the browser completely and open it again**
3. Safari users: Safari also needs the current site allowed under “Settings → Websites → Camera”

### Linux

1. Make sure `/dev/video*` exists and that you have permission for it (see the “Install Node.js on Linux” section above)
2. Click the icon at the left of the browser's address bar → allow the camera
3. If you're using a Flatpak / Snap build of a browser, you may need to grant camera device access in system settings or with `flatpak override --device=all`

---

## Pre-workout calibration

Once you pick an exercise, a **dashed body silhouette** appears in the video: one clean outer contour line (not joint-to-joint skeleton lines) — that's your posture target;
a line of text also appears above the video telling you straight out to “move into the dashed outline”. The calibration panel ticks off each item as it passes: **only “Body detected” and “Full body in frame” are required** (✓ when it passes, ○ when it doesn't — that one blocks the start);
the other five are marked with “·” and are only **recommendations** — following them makes recognition more accurate, but they don't stop you from starting.

| Check | Meaning |
|---|---|
| Body detected (**required**) | The camera can see you clearly |
| Full body in frame (**required**) | Head to feet are all inside the frame, not cut off by the edges |
| Good distance (recommended) | Your body is the right size in the frame (too far or too close, and you get a direction cue) |
| Centered (recommended, standing only) | Your body sits in the middle of the outline (not checked for lying exercises) |
| Good height (recommended) | Your body sits at the right height in the frame |
| Camera angle right (recommended) | Squats need a **front-on** camera, everything else needs a **side-on** camera |
| Holding still (recommended) | Holding still makes recognition steadier (you can start without holding still too) |

**Every exercise has its own silhouette** (chosen automatically from the exercise's camera angle and posture), so just set yourself up to match the outline:
front-facing exercises (Bodyweight Squat / Sumo Squat / Jump Squat / Jumping Jack / Box Jump / Burpee) use a front-on standing silhouette, and the other standing exercises use a side-on standing pose,
push-up exercises (Mountain Climber included) use a **side-on top-of-the-push-up position** (arms straight, hands on the floor), Plank and Side Plank use a **side-on forearm-supported prone position**,
and lying-down exercises like Glute Bridge / Crunch / Lying Leg Raise / Dead Bug use a **side-on lying pose with bent knees** (on your back, knees bent, feet flat on the floor).
When you film from the side, the outline flips left to right automatically to match which way you're facing.

Once the two mandatory checks pass and stay that way for about 0.6 s, the **dashed outline disappears at once** (that is the signal that your whole body has been recognised),
and the 3-2-1 countdown then fires automatically to start counting — there is no button to click.
When a set ends you go back to calibration: this time the outline **also disappears the moment you are recognised**, and you start the next set yourself with “Start set” (or Space) —
so you can rest and look at the summary first instead of being pulled straight into the next set.

**How the dashed outline behaves (one rule for every exercise): it is only there while you are *not* in position — it goes away the moment you are.**

| When | Outline | Why |
|---|---|---|
| No body detected yet | drawn (bright sky-blue, with “can't find you” on screen) | tells you to get into the picture |
| Body detected, not in position yet | drawn (bright amber + exactly what's off) | guides you into the outline (nearer/farther, left/right, turn to face or side on) |
| In position and held (including the rest state after a set) | **not drawn** | you're set up — the outline would only cover you |
| Countdown / counting / paused | **never drawn** (not a single frame) | the screen belongs to the skeleton, the angle labels and the progress bar |
| You drift out of position again | drawn again (after a 0.3 s flicker grace) | leads you back into the outline |

> During a workout the dashed outline can never appear: the main loop has a hard guard that forces
> `outline = null` whenever the session is countdown / running / paused, and a test walks every single
> frame of all 20 exercises to pin that invariant down. To check it yourself, the 🐞 metrics panel now has an
> “**Outline ✓/✗**” item showing whether that frame drew it — after you're recognised it must be ✗.

> If you're not in position, the text prompt above the video and the calibration panel both spell out exactly what to do (for example “move a little toward the camera”, “shift a little to the right”, “face the camera”),
> so you're never left wondering what's wrong.
> For the lying-down exercises (push-up / plank / glute bridge), distance is judged by **body length**, so you don't need to stand up.
> To recalibrate: click the “Recalibrate” button below the video; every set also returns to calibration automatically.

---

## Home page and exercise page

**Home page**: you land on a wall of exercises grouped into **Upper body / Lower body / Core / Full body / Stretching**,
and every exercise gets one card: icon, name, reps or timed, the default target, and the **judging basis** (what that exercise is judged by).
The search box at the top finds exercises by name directly (type “push” or “plank”, for example).

- Click any card → you go to its **exercise page** (camera + form-step checklist + scoring + goal setting + records).
  The exercise page has its own address: `#/ex/<id>` (for example `#/ex/bridge`), so **a refresh keeps you on the same exercise**,
  **the browser Back button returns to the home page**, and you can bookmark the link.
- The 🏠 icon in the top-left corner of the exercise page (its tooltip and screen-reader name is “Back to home”, shortcut `H`) returns you to the wall; the top-right corner has
  🎯 **Exercise settings** (this exercise only) next to ⚙️ **Settings** (global) — all three are icon buttons, so the top bar carries no text buttons and stays narrow on small screens.
  **Going home also leaves fullscreen** (the user asked for it): the “Exit” ring, the 🏠 icon, the `H` key and the browser Back button
  all drop fullscreen first, so the home page comes back laid out normally instead of needing another Esc.
- **🎯 Exercise settings** (shown on the exercise page only, side by side with ⚙️): one modal gathers this exercise's target and
  judging rules — the set target (number box plus preset buttons), this exercise's **judging basis**, its **camera hint**,
  and the **📐 keyframe criteria and scoring** group below (one row per keyframe with its criterion and its points).
  The “② Set target” card in the side panel keeps just a one-line target readout, and its button opens the same modal.
- An exercise can belong to several categories at once (list more than one in `cats` and it shows up in each block, with every card
  opening the same exercise); today each of the 20 exercises belongs to exactly one category.

**The two big numbers in the top-left corner**: the **rep count** (or the **seconds** for timed exercises) sits at the top, and the
**score sits directly underneath it** — the user asked for “the score to be near the count, for example below it, and in a different
font colour”, so the score is **gold (`--score`)**, unlike the white count and the teal goal-progress ring, and you can tell at a
glance which number is the score. The count and the score **share one pulse animation**: a counted rep, form-step points and the
+1-per-second tick all make both numbers jump together. The ring in the bottom-right corner now shows **only the set goal progress (%)**.

## 🟩 Judgement progress bar (the chain of line icons that lights up segment by segment)

The exercise page **always shows** a judgement progress bar (about 95% of the video's bottom edge wide, icons roughly 60-80 px tall): this exercise's keyframes are laid out as segments, and each
segment is a **line-art stick figure** showing what your body should look like at that keyframe. Every recognised pose
lights up one more segment, so you can see what has already been recognised — and **every completed rep resets it to
zero**, then the next rep walks it again from the top.

Take the lunge (each segment holds the real threshold from the code):

```
① Stance    ② Start    ③ Count    ④ Both     ⑤ Back (counts)
≥145°       ≤146°      ≤138°      ≤146°      stand up
 figure      figure     figure     figure     figure
 ✓           ✓          ✓          ✓          ⏳
```

> **Every segment in the chain is a condition for counting one rep, and the last segment *is* the counting moment** —
> so “all keyframes done” means that rep has already been counted; you can never do everything right and get no rep.
> Criteria that do not gate counting (depth / full-marks, timing) **stay off the bar**; they are still listed in the
> 📐 counting-thresholds modal and depth still drives the score (`tests/test-detectors.mjs` verifies per exercise that
> “the chain finished” and “a rep was counted” are at most 250 ms apart).

- **Two states**: with **nobody detected** the whole bar is grey (not started yet); once you are **detected and counting**
  it turns coloured (working). The **done / not-done contrast is four-fold** so it reads at a glance: not done = dashed grey frame
  with thin, faint grey lines; done = solid bright-green fill with thicker green lines, a big **green tick badge** in the corner
  (48 px disc, a 34 px tick, 3 px ring, outer glow) plus a glow on the whole segment; the segment being waited on = thick amber border with a slow
  breathing pulse. Detection flickers, so a short dropout (under 0.7 s) neither greys the bar nor clears progress.
- **Icons first; numbers only when icons can't tell the segments apart**: every icon is a stick figure drawn from that
  segment's own criterion — “Front knee bend ≤ 138°” is drawn as a leg bent to exactly 138°; “Hip lift ≥ 0.22× torso
  length” lifts the glute bridge to that height; “Lift ≥ 0.035× frame height” is drawn airborne; and for a supported pose
  like the push-up the **hand is pinned to the floor while the body height follows the elbow angle** (the more the elbows
  bend, the lower the body). To keep small differences such as 146° vs 138° readable the drawn bend is exaggerated a
  little, but the **order always matches the criteria** (a harder criterion is drawn more extreme).
- **When two segments really do look alike, the criterion's angle is printed inside the icon**: if one exercise has two
  segments on the same joint angle and the two angles are within 12° of each other, every such segment on that chain gets
  its degrees on the icon. The push-up is the classic case: `plank → 150° → 146° → 148°` (146° and 148° draw almost
  identically). A chain that is already unmistakable (squat: 176°→135°→112°→149°) gets no numbers, so the bar is not
  plastered with digits.
- **The glute bridge's three keyframes** (the order the user specified): `supine bent knees → hips driven up → back to
  supine bent knees`. Segments 1 and 3 are the same pose, so segment 2 carries an **up arrow** and segment 3 a
  **down arrow** — you can tell at a glance that the last one is “coming back down to the floor”.
  **The rep is counted the moment you are back on the floor**, i.e. the moment segment 3 lights up.
- **Hover a segment → the criterion for that segment appears above the bar** (for example “Sink · front knee bend ≤ 138°”),
  together with how many points that keyframe is worth; it collapses again when you move the mouse away.
- **How a segment lights up**: only the *next* segment is checked, so the bar has to be walked in order and never skips;
  segments that are lit never go back out. Where a segment has a line, it prefers the **detector's own dynamic line**
  (the squat's `standLine`, the push-up's `backLine`, the lunge's `exitLine`, the bridge's `topLine` / hip angle 165° (either
  signal reaching the top is enough) / `atBottom`, and the
  engine-driven exercises' `progress` line), so “the bar says you reached it” and “the detector accepted it” are always the same line.
- **The last segment is always visible**: for the engine-driven exercises “back to the start” uses the detector's own
  ratio line (`progress ≤ 0.16`), while the icon is drawn from the real criterion shown in the modal (for example
  “knee bend ≥ 157°”, drawn as an almost-straight leg) — deliberately different from the first segment's “standing tall
  (176°)”. Otherwise the “identical drawings are merged” rule would swallow that segment and you would see a full bar
  without a counted rep (a trap we really fell into; `tests/test-specs.mjs` now guards it exercise by exercise).
- **One completed rep lights the whole chain for 0.65 s, then resets it**: the moment the detector counts a rep the bar fills
  the entire chain (even if one segment's criterion sat right on its edge) so you clearly see the round complete; 0.65 s later it
  clears and the next rep walks it again from the first segment. A partial rep (one that didn't count) walks and clears it the same way.
- **The score lives in the keyframes (in a big font)**: every exercise's points are **assigned to specific keyframes**
  (the table is `STEP_STAGE` in `src/specs.js`) — squat = stance 4 / start 6 / count 21 / return 8 + 6 for a perfect round;
  glute bridge = supine 5 / hips up 20 / back down 8 + 6; push-up = plank 5 / start 7 / count 14 / return 8 + 6.
  Before you earn them the segment shows **“up to +N” in small grey type**; the moment a step really passes it turns into a
  **big bright-yellow number** on a dark pill (with a little pop), so “did I do it properly” is visible right on the keyframe.
  For holds, the per-second points also land on the last keyframe and keep counting up.
- **Matching feedback**: lighting a segment plays a light chime that rises step by step (the last one adds an octave); when
  a step earns points that segment pops and a “+N” floats up above the bar. Points only appear when the detector really
  awards them — the bar never jumps the gun just because a pose looks right.
- **The bar never jitters**: the segments are **built once**, and each frame only updates the class and the number of the
  segment that actually changed. It used to rebuild the whole bar's HTML on every point or advance, which swapped the
  elements out and replayed the colour transition, the breathing highlight, the tick and the score pop **from the start** —
  once a second (timed exercises score every second) that is a visible jitter. Now a frame with no state change performs
  **zero DOM writes** (guarded by assertions in `tests/test-app.mjs`: “class change count = 0”, “the elements are always the
  same ones”, and “rendering writes no layout-affecting inline styles”), and the “+N this frame” label above the bar has a fixed
  height so it can no longer push the whole bar down when it appears.
- **A state change never moves any geometry** (the second time the user reported “the bar shakes badly during a workout”, it
  turned out to be animations changing sizes and positions):
  - all three segment states (not done / done / waiting) use the **same 1 px border** — “waiting” used to have a 2 px border, which
    narrowed the content box by 2 px and rescaled the icon inside, so every keyframe made the bar twitch;
  - “waiting” no longer applies `translateY(-2px)`; the thick amber edge is now an **outer glow** (`box-shadow: 0 0 0 2px`) and
    the breathing animation only changes the glow;
  - the “just lit” flash went from “scale up 9% and bounce back” to a **pure glow pulse**, so the big tick badge no longer grows
    and shrinks with it;
  - the end-of-rep whole-bar hint **no longer scales the bar** (it is 1180 px wide, so `scale(1.02)` pushed it out by a dozen pixels
    on each side every single rep) — it now flashes the border and glow only;
  - the score pill has a fixed minimum width and is centred, so growing from `+0` to `+120` no longer widens it once a second and
    shoves the pill to the left.
  All of these constraints are locked by `tests/test-page.mjs` (identical border width across the three states, no `transform` in
  the keyframes, no `transform/width/height` in the transitions), so the animations cannot creep back in.
- **How many segments** (segments drawn identically are merged, so you never see a “fake second step”):
  squat 4 (stand → half squat → squat → back to standing); lunge 5 (stand → step → sink → back knee down → back to standing);
  push-up 4 (plank → **back at the top** (elbow ≥148°) → start (elbow ≤150° or 10° below your own top) → **the bottom = the counting moment** (elbow ≤146° or a 0.08 shoulder drop));
  jumping exercises add a final “Jump” segment (drawn airborne; the jump squat and the box jump both use **≥ 0.035× frame
  height** — the box jump used to sit at 0.05, which the user found too high, so it was nudged down to 0.035); burpee 4 (stand → crouch → plank → jump);
  glute bridge 3 (supine bent knees → hips driven up (lift ≥ 0.35× torso length **or** hip angle ≥ 165°) → back on the floor, **counted as you land**);
  plank/side plank walk through “held up → off the floor → hands planted” (holds have no rep count, so the chain ends on the pose);
  the lying exercises (crunch / leg raise) follow the curl of the torso or the lift of the legs and end back at the start position.
- **One source of truth**: the thresholds behind the icons and the bar are the very same constants used by the detector and
  by the 📐 counting-thresholds modal (see `specStages` in `src/specs.js` and `src/icons.js`), so the bar can never claim
  something the detector does not do. `tests/test-specs.mjs` checks the angle inside each icon, that no icon overflows its
  box, and walks synthetic poses through the bar to prove it advances segment by segment and that a shallow movement never
  reaches the last segment.

## 🖐 Gesture rings after a set (exit / one more set)

The moment a set finishes (the goal was reached, or you tapped “end this set”), **two big rings** appear on the video:
**left = “Exit”** (back to the exercise home page) and **right = “One more set”** (reps, score and the form-step checklist
are all reset and the same set starts again immediately). Right after training your hands are sweaty and far from the
keyboard, so the two most common choices should not force you to tap a screen.

- **Every exercise behaves the same**: rep exercises (squat, push-up, glute bridge …) and timed ones (plank, side plank, both
  forward folds) all bring up the two rings when a set ends, whether it ended by reaching the goal or because you tapped
  “end this set” — no exercise leaves you without a choice.
- **How to use it**: put **either palm** (left or right hand) in the **middle** of a ring and hold for **3 seconds** — the ring
  fills up **clockwise from 12 o'clock** and turns green, and the moment it is full the action fires. Pull your hand away early
  and the progress falls back.
- **The 3 seconds are deliberate**: raising a hand, walking past, or hesitating never triggers it. The hit zone in the middle of
  a ring is about 60% of the ring's radius, so brushing the edge does not count.
- **Tapping the ring with a mouse or finger works just as well** (same chime), and the keyboard still has `Esc` (end this set)
  and `R` (reset the counters).
- **With a mirrored preview the palm position is mirrored too**: in mirror mode the picture you see is flipped while the rings are
  not, so the judgement follows the mirror setting — you never reach left and trigger the right-hand action.
- **The rings are never swallowed because “you are not inside the outline”**: after a lying exercise (glute bridge, crunch, plank,
  seated forward fold) you are not standing in the outline at all, and the rings stay put instead of flashing away.
  They only go away when **a new set really starts** (automatic or by tapping start), when you switch exercise, or when you go home.
- **While the rings are up the top of the screen carries exactly one prompt** (“hold your palm in the middle of a circle for
  3 seconds”): the calibration banner steps aside so the two messages never fight for the same spot — its **text is still kept up
  to date**, so the moment the rings go away you read the current instruction instead of a stale one.
- **“Exit” really means leaving**: going home also **leaves fullscreen** (the user asked for it), so you are never left staring at a
  magnified home page.
- **Only one can fire**: the two rings keep their own timers, and whichever reaches 3 seconds first wins (resting a hand on one ring
  never triggers the other).

## 📐 Keyframe criteria and scoring (inside the exercise-settings modal)

The exercise-settings modal of every exercise lists exactly one group — **🎬 Keyframes and scoring**: it walks the
**segments of the progress bar** one by one — the segment's **line icon**, its number + short label, **the criterion for that
segment** (the very line the bar uses), and **how many points that segment is worth**. The last segment carries a green badge
marking the **“rep counted here”** moment (for timed exercises, **“timer starts”**), and a closing line reads “N segments … the
segment scores plus the perfect-round bonus add up to X points per round”.

**The criteria hang off the keyframes entirely**: the old “counting rules (how far a rep must go to count)” and “posture required”
groups are gone, leaving the keyframes plus the “form reminders” group below (the rows that only trigger a spoken correction and
never cost reps). Any extra criterion that belongs to one segment is listed under that segment:

- **the first segment** (the position a rep starts from): the remaining posture requirements (trunk, heights off the floor …);
- **the “count” segment**: the full-depth line and the “anything shallower is just a wobble” line;
- **the last segment** (rep counted here / timer starts): the shortest rep time, and for timed exercises the timer prime time and the grace period.

Take the squat (the numbers are the constants in the code, one row per segment on screen):

| Keyframe | Criterion | Score |
|---|---|---|
| ① Stance | Hip above knee ≥ 0.86× shin length | +4 |
| ② Start | Hip above knee ≤ 0.78× shin length | +6 |
| ③ Count | Hip above knee ≤ 0.62× shin length | +21 (sink 7 + parallel 14) |
| ④ Return · **rep counted here** | Hip above knee ≥ 0.86× shin length | +8 + perfect-round 6 |

Take the lunge (the groups left are the keyframes plus the form reminders):

| Keyframe / group | Criterion | Score |
|---|---|---|
| ① Stance | Both legs extended ≥ 145° | +4 |
| ② Start | Front knee bend ≤ 146° | +11 |
| ③ Count | Front knee bend ≤ 138° | +11 |
| ④ Both legs | Knee angle of the straighter leg ≤ 146° | +14 |
| ⑤ Return · **rep counted here** | Rise 65% of the way back from this rep’s deepest point, or 8° above it | +8 + perfect-round 6 |
| Form reminder | Back knee close to the floor (spoken only, never costs reps) | Back-knee height off the floor ≤ 0.66× shin |

> Each segment also carries its own extra criteria, for example the squat’s first segment adds “Also required: face the camera,
> trunk tilt ≤ 20°”, its count segment adds “Full depth (earns the depth points): hip above knee ≤ 0.4× shin length · anything
> shallower is just a wobble: > 0.74× shin length”, and its last segment adds “Shortest rep: ≥ 0.48 s”; the lunge’s first segment
> adds “stand side-on to the camera, trunk tilt ≤ 32°” and its reminders include “keep your knees from caving in”.

> That group and the progress bar **share one data source** (`criteriaModel()` in `app.js`: the same segments, the same icons and the
> same “points per keyframe” table `stagePoints()`), so what the modal says a segment wants and pays can never drift from what you
> see on screen — `tests/test-app.mjs` checks the segment count, the icons, the per-segment scores and the round total.

> **These numbers are not a separate write-up — they are read out of the constants the detector actually uses** (see `src/specs.js`):
> the hand-written detectors read the threshold tables `SQUAT / LUNGE / PUSHUP / BRIDGE / PLANK`, the generic engines read each
> exercise's `up / down` and `enter / bottom / loose / ignore` progress from `catalog.js`, the posture gates read `GATE_LIMITS`
> in `engines.js` (the very same table used for judging), and the timed exercises read `HOLD_PRIME_MS / HOLD_GRACE_MS`.
> Change a threshold and the modal follows automatically, so the screen can never claim something the detector does not do.
> `tests/test-specs.mjs` feeds these numbers **back into the detectors** on every test run: a displayed counting line has to land
> exactly on the detector's own progress line (2202 assertions in the suite).

## Settings modal (language / model / sound)

Open the ⚙️ settings modal from the top-right corner of the exercise page — every switch is gathered in there:

| Group | Items |
|---|---|
| Language | 中文 / English (takes effect immediately, switching exercise names and form steps along with it) |
| Pose model | Lite (smoother, the default) / Full (more accurate; the first switch has to download one more model file, and it's offline after that) |
| Sound | 🔊 Voice count · 🎵 Sound FX · 🎶 Music |
| Video & tracking | 🪞 Mirror · 🦴 Skeleton · 📐 Angles · 🐞 Metrics |

Click outside the modal, or press `Esc` or `G`, to close it.

> **Angle labels are never mirrored**: with 🪞 mirror preview on, both the video and the canvas are flipped left-to-right,
> which would also flip the “Knee 132°” / “Elbow 118°” labels drawn on the canvas. The renderer flips itself back the other way,
> so joint angle readouts stay readable while mirroring is on.

---

## How to use it (camera angle matters)

**Front-facing camera: Bodyweight Squat, Sumo Squat, Jump Squat, Jumping Jack, Box Jump and Burpee; every other exercise is done sideways to the camera.**
The first line of “Form steps” on the exercise page spells out how to stand for that exercise (and every card also states its judging basis).

- **Front-facing exercises** (Bodyweight Squat / Sumo Squat / Jump Squat / Jumping Jack / Box Jump / Burpee): face the camera. Depth is judged by “how much higher your hips are than your knees”,
  a quantity that isn't compressed in a front view; and only a front-on view shows whether your knees are caving inward and whether your left and right sides are symmetric.

- Stand **2–3 m (6–10 ft)** away from the camera with your **whole body in frame** (head to feet);
- **Lunge / Reverse Lunge**: stand sideways to the camera so your ankles, knees, hips and shoulders are all visible at once;
- **Push-up / Plank / Mountain Climber**: your body runs perpendicular to the lens, with both hands and both feet inside the frame;
- **Glute Bridge / Crunch / Lying Leg Raise / Dead Bug / Side Plank**: lying down, sideways to the camera, with your shoulders, hips, knees and ankles all visible at once;
- **Stretching**: for Standing Forward Fold, stand up straight sideways to the camera; for Seated Forward Fold, sit on the floor sideways to the camera;
- Even lighting, a clean background, and closer-fitting clothes all make tracking more stable.
- **No sound?** ① check the browser tab is not muted (speaker icon on the tab) ② open settings and flip “🔊 Voice count” once — it speaks a short test line right away ③ open “🐞 Metrics”: the last line shows “Sound” as `running` with a voice count above 0.

**Note the flow: pick an exercise → move into the dashed outline → your whole body is recognised (the dashed outline disappears) → automatic 3-2-1 countdown → counting starts;
after a set ends you go back to calibration, and you click “Start set” (or press Space) to start the next set.**
Calibration only checks that you're in position — it never counts reps or awards points.

> **Fullscreen (`F`, or the ⛶ button in the bottom-right corner of the video frame) enlarges the video frame itself**, not the whole
> HTML page — the side panel, the form list and the score card are not blown up with it.
> **Finishing an exercise and exiting back home leaves fullscreen automatically** (the user asked for it): the “Exit” ring, the 🏠
> icon in the top bar, the `H` key and the browser back button all drop fullscreen first, so the home page is laid out normally
> instead of sitting there magnified with you needing another Esc. **Ending a set alone does not touch fullscreen** — you stay on the
> exercise page and are about to keep training.

**Shortcuts**: `1`–`9` switch exercise · `H` home · `G` settings · `Space` start/pause · `R` reset reps · `Esc` end set · `M` mirror · `S` skeleton · `F` fullscreen the video frame

---

## Exercise library overview (20 exercises)

| Category | Exercise (icon) | Type | Judging basis | Default target |
|---|---|---|---|---|
| 💪 Upper body | Push-up 💪 | Reps | Elbow bend | 12 reps |
| 🦵 Lower body | Bodyweight Squat 🏋️ | Reps | Knee bend (front-on depth) | 15 reps |
| 🦵 Lower body | Sumo Squat 🤼 | Reps | Knee bend | 15 reps |
| 🦵 Lower body | Forward Lunge 🚶 | Reps | Front knee angle + back knee height | 16 reps |
| 🦵 Lower body | Reverse Lunge ↩️ | Reps | Knee bend | 16 reps |
| 🦵 Lower body | Glute Bridge 🌉 | Reps | Hip lift height | 15 reps |
| 🦵 Lower body | Butt Kick 🏃 | **Timed counting** | Knee bend (kicking your heels up, alternating legs) | 60 seconds (see how many you can do) |
| 🔥 Core | Plank 🧘 | Timed | Hold time | 45 sec |
| 🔥 Core | Side Plank 🧎 | Timed | Whether your body position is on target (rough scoring) | 30 sec |
| 🔥 Core | Dead Bug 🐞 | Reps | Leg reach (smaller of knee/hip), alternating sides | 16 reps |
| 🔥 Core | Crunch 🌀 | Reps | Shoulder height off the floor | 20 reps |
| 🔥 Core | Reverse Crunch 🔃 | Reps | Hip hinge | 15 reps |
| 🔥 Core | Lying Leg Raise 🦿 | Reps | Torso-to-leg angle (flat 180° → vertical 90°) | 15 reps |
| 🤸 Full body | Jump Squat 🚀 | Reps | Knee bend + both feet off the floor | 12 reps |
| 🤸 Full body | Burpee 💥 | Reps | Order of the whole sequence (squat → plank → jump) | 10 reps |
| 🤸 Full body | Mountain Climber ⛰️ | Reps | Left/right leg alternation | 24 reps |
| 🤸 Full body | Jumping Jack 🙌 | **Timed counting** | How wide your legs open | 60 seconds (see how many you can do) |
| 🤸 Full body | Box Jump 🦘 | Reps | Knee bend + both feet off the floor (rough scoring) | 10 reps |
| 🧘 Stretching | Standing Forward Fold 🙇 | Timed | Whether your body position is on target | 30 sec |
| 🧘 Stretching | Seated Forward Fold 🧎‍♂️ | Timed | Whether your body position is on target | 30 sec |

> “Jump Squat” has been moved back into **Full body** at the user's request (Full body now holds five: Jump Squat / Burpee /
> Mountain Climber / Jumping Jack / Box Jump), and Lower body gained **“Butt Kick”** (standing in place, kicking your heels up
> towards your glutes one leg at a time; it later became **timed counting** — a fixed 60 seconds to see how many you can do) — every exercise belongs to exactly one category.
> The same exercise can still appear in more than one category — whatever you list in its `cats` array is where it shows up (right now each of the 20 exercises belongs to one category).
> The judging basis is **what the camera actually measures**; exercises marked as **rough scoring** (Side Plank, Box Jump and so on) can only tell that
> “your body position is roughly on target” — scoring and timing still work as usual, but don't treat them as a strict posture referee.

---

## Scoring rules

The right side of the interface has a **form-step checklist**: hit a step and it's immediately checked off, scored, and chimed, and the step you should be doing next is highlighted.
Completing **every form step in the round** earns an extra perfect-round bonus, and hold exercises add **+1 point for every second you hold it**.

### Squat (45 points per round)

Squats use a **front-on** camera angle, and depth is judged by “how much higher your hips are than your knees / shin length” (standing tall ≈ 1.0, thighs level ≈ 0):

| Form step | How it's judged | Points |
|---|---|---|
| ① Stand facing the camera with your whole body in frame and your body upright | Front view + full body visible + body vertical + hips clearly above the knees (ratio >0.86) | +4 |
| ② Bend your knees and sink down, hips going downward | Hip-knee height ratio ≤0.72 (thighs about 46° from horizontal) | +6 |
| ③ Bend both knees, tracking over your toes | Ratio ≤0.50 (about 30°) | +7 |
| ④ **Squat until your thighs are near horizontal (top-scoring step)** | Ratio ≤0.25 (thighs within about 15° of horizontal, or lower) | **+14** |
| ⑤ Drive up to standing, full hip and knee extension | Ratio back to ≥0.80 | +8 |
| 🎁 All form steps complete for the round | All 5 steps above hit within the same round | +6 |

### Lunge (54 points per round)

| Form step | How it's judged | Points |
|---|---|---|
| ① Stand sideways to the camera, upright and full body in frame | Side view + full body visible + body upright + both legs basically straight | +4 |
| ② Step one leg forward, feet split front and back | Front-to-back ankle distance > 0.45× torso length | +5 |
| ③ Make it a big stride with a wide front-to-back split | Front-to-back ankle distance > 0.9× torso length | +6 |
| ④ Bend both knees and sink down, front knee around 90° | The more bent leg ≤118° and the other ≤150° | +11 |
| ⑤ **Lower your back knee close to the floor (top-scoring step)** | Back-knee height off the floor ≤0.35× shin length | **+14** |
| ⑥ Drive through your front foot back to standing | Both legs straight again (after first sinking down) | +8 |
| 🎁 All form steps complete for the round | All 6 steps above hit within the same round | +6 |

> **Both lunges (forward and backward) now ask for more knee bend in the later keyframes** (the user reported they felt “too
> sensitive — the later keyframes could demand a bigger knee bend”): the forward lunge's counting line moved from **152° to
> 138°** (about 35° of bend from standing), and the backward lunge's from progress 0.55 to **0.70** (a front knee around
> **123°**); the full-depth lines were deepened to match (forward 128° → **122°**, backward 0.85 → **0.92**, about 110°).
> **A 90° front knee is still not required**: a half lunge still counts — only “a quick dip of the front leg / bending to just
> 15x°” no longer adds up. Those cases are logged as partial reps with a spoken “sink a little deeper”, never silently ignored.
> The `enter`/`exit` lines still follow **how straight you personally stand** (compressed readings never cause bogus counts), and the
> “too fast” check only applies to rounds where you really sank down.

> **A lunge requires *both* knees to bend (no front-leg-only dipping)**: watching the front knee alone lets a quick front-leg dip score a rep.
> The detector now also tracks the **straighter leg (the back one)**: it has to bend to **146°** or less (or at least **18°** below how straight
> you personally stand, whichever is stricter — these used to be 158°/12°) for the rep to be valid. Moving only the front leg is logged as a partial rep and the voice coach
> says “Bend both legs: the back leg has to bend and sink too”. A back leg that bends less but genuinely bends still counts — the lenient baseline stands.
> The 🐞 panel's “Both knees (back/line)” line shows this round's measured value and the line.

### Push-up (40 points per round)

| Form step | How it's judged | Points |
|---|---|---|
| ① Hands on the floor, body in one straight line | Push-up position + body line angle ≥150° + deviation ≤0.18 | +5 |
| ② Brace your core and bend your elbows to lower down | Elbow angle ≤138° | +7 |
| ③ **Elbows bent until your chest is near the floor (top-scoring step)** | Elbow angle ≤118° and the body still in one straight line | **+14** |
| ④ Press back up to nearly straight arms | Elbow angle ≥ your own top −10° (about 146–148°; it follows your own range) | +8 |
| 🎁 All form steps complete for the round | All 4 steps above hit within the same round | +6 |

> **Note that ②③④ above are the *scoring* lines, not the *counting* line.** Counting only needs the keyframe chain to
> complete (elbow ≤146° or a 0.08 shoulder drop), so a rep that only reaches 146° **still counts** — it just misses the
> ②③ points, has its quality score discounted by depth, and hears “go lower”. That splits “however much you do counts”
> from “the deeper you go, the higher you score”.

> **The “return to the top” line follows *your* range (important)**: on a real camera the projection makes “arms straight / standing tall” read lower
> (a side-on push-up often reads only 140–150°). If the detector insists on an absolute 145/168° to close a rep, the rep never closes and
> every following rep is merged into it — **ten reps, one or two counted**. The start position is now the largest range you actually reached in the last 1.5 s,
> so coming back near your own top closes the rep; and if a rep gets stuck, it is force-settled after 9–12 s, so reps are never swallowed.
> Every rep exercise also shows a “Rep diagnosis” line in the 🐞 panel.
>
> **The push-up count was loosened a second time (the user measured: “elbow ≤138° or a 0.14× torso shoulder drop is
> too strict, nothing counts”)**: a side camera plus smoothing **flattens the elbow reading as a whole** — many people top
> out around 145° even at full depth — and the shoulder drop is really the same movement seen from another angle (if your
> elbow only bends to 146°, your shoulders can only sink a little). Both sides were stuck, so nothing counted.
> Both were loosened together and the start / count / close relationship was made explicit:
>
> | Stage | Criterion | Before |
> |---|---|---|
> | Starting the rep | 10° below your own top, or elbow ≤150°, or a 0.05 shoulder drop | 22° / ≤146° / 0.08 |
> | **Counting** | Elbow ≤**146°** or shoulder drop ≥**0.08×** torso length | 138° / 0.14 |
> | Full depth | Elbow ≤128° or shoulder drop ≥**0.26** | 128° / 0.30 |
> | Closing (back at the top) | Elbow back within 8° of your own top **and** shoulders back within 0.06 | shoulders 0.08 |
> | Wobble filter | Less than 8° below your top and no 0.08 shoulder drop → no count, no nagging | 12° |
>
> Measured (synthetic skeleton through the real pipeline): an elbow bottoming out at **145°** now counts every time
> (it counted zero times before), while 148° with only a 0.079 shoulder drop still does not — the counting line and the
> measured boundary agree. The four shoulder thresholds are deliberately ordered
> `start 0.05 < close 0.06 < count 0.08 < full 0.26`: **closing has to be shallower than the counting line**, otherwise the
> single frame where you begin to sink but your elbows have not bent yet is read as “shoulders back up *and* deep enough”,
> inventing a rep (that is exactly why this release splits it out of the reused 0.08).
> **The counting moment is the bottom of the movement** (the user asked for “the counting moment to be when the body
> reaches its lowest point, with immediate feedback — it just feels better”):
>
> | Before | Now |
> |---|---|
> | The rep was counted when you pressed back up to the top, so you reached the bottom and still had to wait half a second for the call-out | **It counts the moment you bottom out**: the call-out, the sound and the counter all fire right there |
>
> “You bottomed out” takes either of two signals:
> - **you start coming back up**: the elbow recovers **4°** above this rep's lowest value (or the shoulders recover **0.03× torso**);
> - **you hold at the bottom**: neither signal sets a new low for **0.18 s** (some people pause a beat down there).
>
> Why this is needed: the depth line alone (elbow ≤146°) is crossed by a big-range rep (top 172°, bottom 85°) when it has
> only bent **10°** — still at the very top of the movement, nowhere near the bottom. With “and you bottomed out” added, the
> count lands at the real bottom (`tests/test-detectors.mjs` pins the phase: the count falls inside 0.42–0.68 of the cycle,
> with the elbow still inside 120°).
>
> **Pressing back up to the top is still required, as the precondition for the *next* rep**: after counting, the detector
> parks in a “pressing up” state and only allows the next rep once your elbow is back within 8° of your own top and your
> shoulders are back within 0.06 — so holding at the bottom **cannot farm reps**. That is also why the “press back up” step
> (+8) still belongs to this rep and still scores (the round's closure and the full-round bonus are settled as you arrive
> back at the top).
> **The four segments are: plank → back at the top (+8) → start lowering (+7) → the bottom, counted (+14 + 6 bonus)**, and
> the last segment uses the detector's own “bottomed out” flag (`atBottom`), so “segment lights” = “rep counted” = “counter
> and sound” in the same instant. There is no strict mode: that segment is the only counting rule.
> Scoring still rewards depth: the form step “elbows bent until your chest is near the floor” (+14) still requires 118°,
> so reps counted at 146° still count but score less and get a “go lower” cue.

> **It counts even when the camera can't see the floor (camera-angle compensation)**: with a laptop sitting on a desk and looking down,
> you simply can't see the chest touching the floor in the frame, and the 2D projection makes the elbow angle **read straighter than it really is**
> (even a full rep may only read 140°). So push-ups now have a second depth signal that doesn't depend on the elbow:
> **how far the shoulders dropped** (about 1.2× torso length at the top, down to roughly 0.5 at the bottom). A shoulder drop of
> **0.08× torso length** already counts as “the body really did get close to the floor”, **0.26×** earns full depth credit
> (these were loosened in steps: 0.20/0.40 → 0.14/0.30 → 0.08/0.26), and even “this rep has started” can be triggered by a
> **0.05×** shoulder drop. Either signal is enough, so any camera height works.
> The 🐞 panel shows the live “Shoulder drop” and “Counting line” values.

### Glute Bridge (39 points per round)

| Form step | How it's judged | Points |
|---|---|---|
| ① Lie on your back with knees bent, feet hip-width apart and planted | Supine bent-knee position (shoulders on the floor, knees off it) | +5 |
| ② Squeeze your glutes and drive your hips up | Hip lift > 0.15× torso length | +6 |
| ③ **Lift until shoulders, hips and knees are almost in a straight line (top-scoring step)** | Hip lift > 0.35× torso length **or hip angle ≥ 165°** | **+14** |
| ④ Lower your hips back to the floor under control | Uses your own “back on the floor” line (after first lifting up) | +8 |
| 🎁 All form steps complete for the round | All 4 steps above hit within the same round | +6 |

> **The glute bridge's lines follow you, and “all three keyframes done” now always counts**: it used to require a hip lift
> above 0.35 for depth credit and a drop “back below 0.12” to close the rep — but everybody's lying-down hip baseline is different, so if yours
> sits above 0.12 you **already qualify the moment you lie down**; the lift then never closes the rep and **every following rep is merged into it,
> so ten reps score one** (exactly the “all three keyframes right, but no rep counted” report). Now the detector remembers **your own lowest point**
> in the set as the baseline: `back on the floor = within 0.08 above your own lowest point`, and the top line is
> `0.16 above your own lowest point (never below 0.22)`. A rep is counted **the moment you come back down from the top** —
> the same instant the bar's third segment (“back to supine”) lights and the 3-segment chain completes into a rep.
> A whole round (leaving the floor → back on the floor) shorter than 0.42 s is treated as a bounce: no count, just a
> spoken “slow down and control it” cue.
> The 🐞 panel's “Hip lift (baseline)” line shows the measured value and the current line together.

> **User feedback from real testing: ~170° really is the top of the movement** — but **height alone misses it**: your height and
> leg length, how far your shoulders come off the floor and even the camera angle all shift that ratio, so some people can never
> reach 0.35× torso length no matter how hard they squeeze, and then “I clearly hit the top but nothing counts”.
> So the third segment (and the main scoring criterion) now accepts **either of two signals (OR)**:
>
> | Signal | Criterion | Notes |
> |---|---|---|
> | Lift height | Hip lift above your own top line (≈ 0.35× torso length) | The original path, easier for shorter legs |
> | **Hip joint angle** | **shoulder-hip-knee angle ≥ 165°** | The user's measured top is ≈ 170°, leaving 5° of margin |
>
> The hip angle is the very number behind the on-screen “Hip” label (the shoulder-hip-knee angle): **roughly 135–145° lying flat
> and 170–180° when the body is a straight line**. The 165° line sits in between, so **“only lifted halfway” (≈ 160°) still does
> not count as reaching the top** and a half bridge is never mistaken for a rep, while a genuine 170° top always crosses it.
> The rep is still counted **the moment you come back down from the top** — the same instant the third segment lights up.
> The 🐞 panel gains a “Hip angle (angle criterion)” row showing `current / 165` live, so you can tune it against the numbers.

### Plank (70 points per set, plus 1 point per second)

| Form step | How it's judged | Points |
|---|---|---|
| ① Forearms under your shoulders, push your body up | **Shoulder joint angle (hip-shoulder-elbow) 45°–135°**, or shoulders off the floor + hands on the floor | +8 |
| ② Head, back, hips and ankles in one straight line | Body line angle ≥148° + no sagging, no piking | +12 |
| ③ Hold steady for 3 seconds | Held for a full 3 seconds | +10 |
| ④ Hold steady for 10 seconds | Held for a full 10 seconds | +15 |
| ⑤ Hold steady for 30 seconds | Held for a full 30 seconds | +25 |
| ⏱ For every second you hold | While your form is valid | +1/sec |

> **The user reported “the plank never times”, suspecting the “hands within 0.55× torso of the floor” rule was too strict —
> exactly right, and it is now fixed.**
>
> Reproduced: **a textbook plank stops timing whenever the calibrated ground line sits below your body** (on a bed or sofa, or
> with the camera slightly off), because the hand height then measures **0.68 > 0.55** — the screen keeps saying “plant your
> forearms on the floor” and the clock **never starts**. The user also described what he expects: “**judge it by the joint
> angles**: elbow about 90°, **shoulder about 90°**, hip and knee about 180°, trunk tilt about 80°, and don't be so strict about
> the hand height”. Measured on a standard forearm plank: **trunk 78° / shoulder 78° / elbow 90° / hip 180° / knee 180°** — the
> same numbers.
>
> So “are you propped up?” now takes **either of two signals**, the primary one an **angle** (no ground line involved):
>
> | Signal | Criterion | Measured |
> |---|---|---|
> | **Shoulder joint angle** (new metric `shoulderAngle` = hip-shoulder-elbow) | **in 45°–135°** | forearm plank ≈78°, straight-arm plank ≈90°, **lying flat resting with the arms at your sides ≈10°**, standing ≈25° |
> | The old ground-line rule (fallback) | shoulders ≥0.10 off the floor **and** hands/forearms within 0.55 | kept as an alternative, so anything that used to work still does |
>
> - “Body close to horizontal (trunk tilt ≥38°)” is still required; standing (4°) fails both signals just as before.
> - A sagging or piked hip, an imperfectly straight body, low knees and an ambiguous elbow reading still only trigger a
>   **spoken correction plus a quality discount** and never pause the timer.
> - **The on-screen labels follow the criteria**: the plank now prints **“Shoulder xx°”** (hip-shoulder-elbow — the angle that
>   decides whether the clock runs), **“Elbow xx°”** (forearm plank ≈90°, straight-arm ≈175°), “Hip xx°” and “Trunk xx°” — all
>   four numbers the user described are on screen.
> - The two bar segments are **① held up (trunk tilt ≥38°) → ② arms propped (shoulder joint angle 45°–135°, timer starts)**.
> - The +8 “get up into position” scoring step now uses the same rule (angle first, old rule as fallback), so the detector and
>   the scoring can no longer disagree.

### About the exercises that are not in this list

> This version of the exercise library was trimmed to the 20 exercises on the given list, and Static Glute Bridge isn't one of them — if you want it back,
> copy the `bridge` entry in `src/catalog.js`, change `kind` to `'hold'`, and run `npm test` once more
> (the detection engine and the scoring plan are both already there — see [Tuning scores and thresholds yourself](#tuning-scores-and-thresholds-yourself)).

### Generic “family” scoring plans

On top of the 5 hand-written plans above, the remaining exercises share **family plans** (exercises of the same kind are judged by identical logic, only the thresholds differ):

| Family plan | Used by | Step structure |
|---|---|---|
| Standing bend | Sumo Squat, Reverse Lunge | Set up → bend your knees and sink → hit the target range → drive back to standing |
| Supine lift | Crunch, Reverse Crunch, Lying Leg Raise | Lie down → start the movement → lift all the way → lower back under control |
| Alternating | Dead Bug, Mountain Climber | Get into position → first tuck/extend → switch sides → keep the rhythm (the **dead bug's criteria and keyframes were redesigned**, see below) |
| Standing alternating | Butt Kick | Stand tall → kick → kick the other leg → keep the rhythm |
| Multi-stage | Burpee | Stand → squat and plant your hands → complete the middle stage → stand up and finish |
| Jump family | Jump Squat, Box Jump | Stand → bend your knees and load → **both feet off the floor** → land with bent knees |
| Jumping Jack | Jumping Jack | Feet together → jump them open with both arms overhead → reach the widest spread → jump back together |
| Timed (posture) | Side Plank | Get into position → body in one straight line → hold 3 / 10 / 30 seconds |
| Timed (stretch) | Standing Forward Fold, Seated Forward Fold | Enter the stretch → breathe and relax → hold 10 / 20 seconds |

Timed family plans also give **+1 point for every second you hold**; if your form collapses for more than 1.2 seconds, the timer pauses and the voice reminds you.

### Dead Bug (its criteria were redesigned after user feedback)

> **The user reported: “the dead bug's keyframe criteria all feel wrong”** — and they were: it had been given the generic
> alternating-family rule (**just one side's knee angle ≥150°**), which is wrong in three directions:
>
> | What was wrong | Why |
> |---|---|
> | ① A wrong movement also counted | Kicking only the shin straight with the **thigh still vertical in the tabletop (foot to the ceiling)** also satisfies “knee ≥150°”, but that is a knee extension, not a dead bug |
> | ② A real rep did not count | The leg genuinely reached out but the knee was a few degrees short of straight (very common with tight hamstrings) |
> | ③ Both legs extending together counted | When both legs cross the line on the same frame the engine credits the deeper side — but “one leg at a time” *is* the exercise |
>
> **The criteria now** (three keyframes):
>
> | Keyframe | Criterion | Reference values |
> |---|---|---|
> | ① Supine (tabletop) | Lying on your back (trunk tilt ≥36° + shoulders ≤0.6× torso off the floor); the icon draws the **tabletop**: both knees bent 90° with arms straight up | thighs vertical, knees at 90° |
> | ② Extend (counting line) | **Leg reach ≥132°** **and** **the other leg stays in the tabletop ≤120°** | tabletop ≈90°, extended flat ≈170–180° |
> | ③ Switch (counting moment) | The other leg reaches out too (≥132° while the first returns to ≤112°); the switch landing counts the rep | at least 0.5 s apart |
>
> - **“Leg reach” is a new metric `legOut` = the smaller of the knee angle and the hip angle** (`src/metrics.js`).
>   A dead bug needs the knee nearly straight **and** the thigh genuinely opening away from the tabletop; both must arrive —
>   the knee angle alone lets “foot to the ceiling” through, the hip angle alone lets “leg lowered but knee still bent” through,
>   and taking the smaller value blocks both.
> - **The other leg has to stay in the tabletop** (the engine's `params.otherHold`): it is a condition for counting and is shown
>   in the same keyframe (“… **and** the other leg ≤120°”). Both legs extending together no longer scores a free rep.
> - **The switch no longer eats a rep**: the leg you just extended needs roughly 200–400 ms to get back to the tabletop while the
>   other leg is already reaching out, so the rising edge lands on frames where “the other leg is not home yet”. The detector now
>   **holds that extension pending** and credits it as soon as the other leg really is back in the tabletop *and* this side is still
>   extended (only after 1.2 s does it conclude “both legs are moving” and speak a correction).
>   Before the fix: 4 switches counted 1; after: 6 fast switches count 6 (`tests/test-engines.mjs` guards it).
> - **Keyframe names and icons changed too**: the short labels are “Extend / Switch” (no longer the generic “Work / Switch”) and the
>   icons are drawn **supine** — the tabletop with both knees bent, then the near leg extended (far leg bent), then the reverse
>   (far leg extended, plus a down arrow). These three segments used to fall into the generic branch and were drawn as a
>   **face-down prone** figure (that is the mountain climber) with a knee-angle number, which looked plainly wrong.
> - **The direction in the criteria text was fixed**: the alternating note had “≤” hard-coded, so the dead bug's modal claimed the
>   counting line was “≤150°” — exactly backwards. It is now generated from `cmp` (dead bug “≥132° / return to ≤112°”, butt kick
>   “≤126° / back to ≥132°”).
> - The 🐞 panel adds a “Both sides” row (that `legOut` value) and an “Other-leg rule ≤120” row, so you can see which condition
>   you are stuck on.


> **How the lying leg raise is judged**: the criterion is literally the **torso-to-leg angle** (the angle between your legs and
> your upper body, in degrees) — **flat on the floor with straight legs ≈ 180°** → lift the straight leg so the angle shrinks →
> **legs vertical, about 90° to your torso** → lower back to ≈ 180°, repeat.
> `up = 180` is the starting line (self-calibrated to the flattest angle *you* actually reach) and `down = 90` is legs vertical.
> The four bar segments are **flat → start lifting (≤151°) → count (≤105°) → back down flat (≥158°, with a down arrow)**.
> Both ends are deliberately forgiving, as the user asked:
> - **about 90° counts**: the counting line sits at **105°** (anything within 15° of vertical counts) and the full-depth line at **95°**;
> - **flat legs are enough to start the next rep**: the return line sits at **158°** — still 22° away from flat and the rep still
>   closes, so a rep is never lost just because you did not flatten out completely;
> - the starting segment draws **lying flat with straight legs** (not the bent-knee glute-bridge/crunch pose); if you bend the
>   knee (which can still reach 90°), the voice reminds you to keep the leg straight — and that is **advice only, it never costs
>   you a rep**. The tolerance is a **knee angle ≥ 130°** (the user asked for it to be forgiving: “anything above 130° is fine”),
>   so it only speaks up once you bend past that, and the same line is listed under “form reminders” in the settings modal.
> - the on-screen angle label and the 🐞 metrics panel use the same “Hip” wording as every other exercise — the whole app has one
>   single name for this angle, with no per-exercise special case.
> - **“Are you lying down?” now takes either of two signals (two rounds of user feedback)**: the first round asked to keep
>   only “shoulder height off the floor ≤ 0.6× torso length” and drop the old “trunk tilt ≥ 36°” line; the second round
>   reported **“it never lets me into the starting position”**. The cause was that one surviving line **depending on the
>   calibrated ground line**: on a bed or sofa, or with the camera at your feet, the ground line sits below your body, so a
>   perfectly flat position reads “shoulders 0.69× torso above the floor” and is judged as “not lying down” (measured: a
>   textbook flat pose at trunk 90°, hip 180°, knee 178° was blocked). It is now **trunk close to horizontal in the frame
>   (≥55°, no ground line involved)** **or** **shoulders within 0.6× torso of the ground line** — either one counts as lying
>   down. Standing (trunk 10°, shoulders 1.2) satisfies neither and is still blocked. The modal and the first bar segment state
>   “A **or** B” too — they used to render it as an extra “and”, which read stricter than the real rule. The dead bug shares
>   the same lying-down rule (both signals, either one is enough).
> - **The starting position is simply lying flat**: the on-screen prompt now uses this exercise's own wording — “Lie flat on
>   the mat: body flat, legs straight and relaxed (hip and knee both flat, about 180°)” — it used to reuse the generic “on your
>   back with knees bent”, which is the bridge/crunch position.

> **How the jumping jack is judged**: face the camera and the “open/close” is measured as the **leg spread**
> (`legSpread` — **whichever is wider, the knees or the ankles**, in torso lengths), so
> progress = (narrowest − current) / (narrowest − widest) and “together → open → together” is exactly one rep.
> The line follows **the narrowest stance you personally hold** (the engine's `effUp` self-calibration), so someone who
> naturally stands wide still gets counted.
>
> The user reported “the jumping jack never counted, it got stuck on the third keyframe”, and the cause was a criterion that was
> too strict: ① it measured **only the knees** — in a real jack the legs push outwards so the **feet spread much further than the
> knees**, leaving knee readings of 0.8–0.9 against a counting line of 0.98; ② the “widest” reference was set at 1.5× torso length
> (about 85 cm of knee separation), which a real jack never reaches. It now takes **the larger of knees and ankles** (never the
> smaller, and it still works when the feet leave the frame and only the knees are visible), the reference range is tightened to
> **0.30 – 1.25**, and — at the user's request — the bar keeps **only three keyframes** (at this pace the “start” frame flashes by in
> 0.6 s and carries no information): **① Stance → ② Jump open (count ≥ 0.66) → ③ Close (≤ 0.54)**, with the
> points becoming **4 / 21 / 8 + perfect-round 6** (still 39 per round); the shortest rep went from 300 ms to **400 ms** (a real jack
> takes about 0.6–1.0 s, anything faster is treated as a twitch).
> The “close” form step was also loosened to progress 0.45, because it has to be scored **before** the detector closes the rep —
> otherwise it always misses by one frame and the perfect-round bonus never lands.
>
> Speed is normal here and only a quick bounce is filtered out. The keyframe icons are **front-view stick figures**: feet together
> (arms down) → open (legs spread, hands overhead) → widest → back together (with a down arrow, meaning “return to the start
> position”). The 🐞 metrics panel now also shows **“🎯 the quantity this exercise is actually judged by, plus progress”**
> (for the jack: “Leg spread 0.83 (progress 52%)”), so exercises whose criterion is not a joint angle can be debugged by the numbers.
> **The screen also labels “Spread 0.83” directly** (between your legs, in the same pill style as the angle labels) — the user asked
> “why does the jumping jack show no angle?”, and the answer is that it is not judged by one; this number *is* its criterion, and
> anything at or above 0.66 counts.
>
> **It is “timed counting”** (the user asked for a fixed 60 seconds to see how many reps you can do) — see the next section.

### Timed counting (Jumping Jack / Butt Kick: a fixed 60 seconds, see how many you can do)

The user asked for “the jumping jack to become timed counting, say a fixed 60 seconds, to see how many reps I can do”, and then for
“the butt kick to become timed counting too, say one minute of butt kicks, to see how many I can do”. The implementation adds one
field to the exercise catalog — **`seconds`** (`catalog.js`): any **rep** exercise that sets it becomes **timed counting**.
**Two exercises use it today**: the **Jumping Jack** (Full body) and the **Butt Kick** (Lower body), both a fixed **60 seconds**,
both with an adjustable duration in 🎯.

- **The rep rule does not change at all**: the keyframes are still walked one at a time and a full circle is one rep (jumping jack:
  together → jump open → back together; butt kick: stand → **kick** → **kick the other leg**). The criteria, the points, the icons and the
  progress bar are identical. The only thing that changes is **when the set is finished**: from “reach the rep target” to
  “**the time is up**” (`isTimedReps()`, `catalog.js`).
  > The butt kick's keyframes are named “**Kick**” and “**Kick the other leg**” as the user asked (the generic alternating wording is
  > “Work / Switch”, which reads oddly for a butt kick). The points still land on the same segments: **5 / 10 / 22 + 6 per round**.
- **The target is a duration, the result is a rep count**: so these exercises have **two units** — the target is in seconds
  (`localizedExercise().targetUnit`) and the result is in reps (`.unit`). The 🎯 exercise settings offer
  **30 / 45 / 60 / 90 / 120 seconds** and the ＋/− buttons step by **15 seconds**; the duration is stored separately in
  `settings.seconds` so it can never be confused with the rep target (these exercises used to target 50 and 20 reps, and reusing the
  same field would have produced a nonsensical “50 seconds”).
- **On screen**: the big number is still the **rep count** (how many you did), the line below it reads
  `⏱ 42 / 60 sec left`, and the progress ring tracks **time**.
- **Voice**: the remaining time is called at **45 / 30 / 15 s** (“N seconds left”) plus a dedicated
  “Last 5 seconds — push!”; reps are still announced every 5 (`speakEvery: 5`). When the time is up it says “Time is up, awesome”,
  and the set summary announces “**52 reps in 60 seconds**” plus a compliment (still never the score).
- **Counting stops the instant the time is up**: the extra reps you do during the 2.6 s celebration **do not** go into the result
  (the main loop gates `feedDetector()` on `state.timeUp`), and the set time stops at exactly 60.0 s.
- **Summary and records**: the summary shows “valid reps 52 / completion 100% (measured by time) / set time 01:00” and the note reads
  “⏱ 60 seconds up: 52 reps done · N points this set”; 🏆 best scores and 📜 history both write it as **“52 reps / 60 s”**, so
  training at a different duration stays unambiguous.
- **Reaching the goal is decided by time alone**: the usual “hit the rep target and you're done” and “halfway there” prompts do not
  apply to timed counting (60 reps ≠ 60 seconds), and a test pins both of those down.
- **Adding more later is a one-line change**: give any rep exercise `seconds: N` in `catalog.js` and set `target` to the same number —
  everything else follows automatically.
- To train 30 or 90 seconds instead, change the duration in 🎯 exercise settings (it only affects that exercise).

> **How the butt kick is judged**: standing in place, alternating legs and kicking your heels up towards your glutes. The criterion
> is the **knee bend** of the kicking leg, and the three keyframes are **① Stand → ② Kick (that leg's knee ≤ 120°) →
> ③ Kick the other leg to ≤ 120° as well (the switch is what counts the rep)**. The icons are **standing butt-kick stick figures**
> (standing tall, then kicking the near leg, then the far leg) rather than lying-down figures — the user reported “the icons should
> be the standing butt-kick icons”, because the per-side metric used to fall through to the generic branch and get drawn lying down.
>
> The last segment uses **the detector's own “switched” flag**, so the moment it lights up *is* the moment the rep is counted;
> “the leg you just used has to come back to ≥ 126°” is only a supporting condition, written in that row's note inside the modal
> instead of taking a segment of its own.
> Because of that pace it also **announces the count only every 5 reps** (`speakEvery: 5`), just like the jumping jack.
>
> This move lands about two kicks per second, so the timing thresholds were loosened: `holdMs` 60 ms → **25 ms** (it used to require
> two straight frames, so one flicker dropped a rep) and `minRepMs` 180 ms → **110 ms** (anything faster than that was swallowed
> entirely). Because of that pace it also **announces the count only every 5 reps** (`speakEvery: 5`), exactly like the jumping jack.
>
> #### “Slow kicks count, normal or fast ones don't” — the alternation rule was too rigid (fixed)
>
> The user reported three times: “with the butt kick I can get it recognised if I go slowly, but at normal speed or a bit faster it no
> longer counts”, then “if I do it really fast it still doesn't count reliably”, and finally “it feels much better now, but a few kicks
> still don't get counted”. Reproducing all of them through the **real pipeline** (synthetic pose → smoothing → metrics → detector)
> turned up **four** causes, all in the **left/right alternation rule** (the butt kick, the mountain climber and the dead bug share
> this engine):
>
> 1. **The old rule demanded that the other leg be almost straight**: one side active (knee ≤ `onValue`) **and the other ≥ `offValue`**.
>    In a real fast butt kick the support leg's knee is nowhere near straight (it measures **120°–140°**), so the old
>    `offValue = 135°` almost never held → **nothing counted at all**; going slowly worked only because you straighten the leg onto
>    the floor between kicks. **Now the rule is simply “the other side is not kicking at the same time”** — the actual meaning of
>    alternating — so a bent support leg still counts as resting.
> 2. **The “active” threshold was too deep**: at speed, motion blur, sampling and the smoothing filter make the **sampled** minimum knee
>    angle 10°–30° shallower than the truth, so the old `onValue = 100°` was often never reached. It was **loosened step by step to
>    126°** (`offValue = 132°`, a 6° hysteresis band). Boundaries, both pinned by tests: jogging in place only dips to ~150° and a fast
>    jog's knee lift to ~133° → **not counted**; a clearly lifted knee (~115°) → **counted**. That is the **relaxed mode** the user asked
>    for.
> 3. **A very fast kick is over in a single frame**, while both older counting paths needed one more frame: “hold for `holdMs`” could
>    never catch a one-frame spike, and “count when the leg returns to rest” also missed — the kicking leg only comes back to
>    121°–126°, so the **hysteresis state gets stuck** and every following rep is lost. **Counting now happens on the rising edge into
>    “active”** (`countRises`): it only asks whether this frame crossed the line, independent of the exit line, so single-frame spikes,
>    very narrow peaks and low frame rates all work.
> 4. **Both legs crossing the line on the same frame** (found only in the last round): in a fast butt kick you are bouncing in place, so
>    the **support leg dips too** and both legs often cross the judged line within one frame. The old code required *exactly one* side to
>    enter and threw that frame away — a whole rep lost. Now, if one side is **clearly deeper** (by ≥ `leadMin` = 18°, meaning that leg
>    is the one really kicking), the rep is credited to it; two legs at the same depth (bending together, not alternating) still do not
>    count.
>
> Two safeguards remain: the **hysteresis state** (enter 126° / exit 132°, used only for the on-screen depth bar and the 🐞 diagnosis,
> never for counting) and the **700 ms timeout** (a side active for more than 0.7 s is considered finished, so no state can lock up).
>
> The same fixes apply to the **mountain climber** (enter 112° / exit 124°).
> The **dead bug** later had its whole rule set redesigned at the user's request (its problem was never speed — it was judging
> the wrong thing; see the dedicated section above).
>
> **Measured result** (real pipeline, one cycle = one kick on each leg; kicks reach a 70° knee angle): 700–300 ms per leg (1.4–6.7 kicks
> per second) counts **103%–113%** at 30 fps; a support leg dipping 25° every step, shallower kicks (knee only to 100°) and narrow spikes
> (kick and return) all stay at **104%–106%**; the same narrow spikes only reached 61% with the previous thresholds. Low frame rates keep
> 104% down to ~500 ms per leg and start losing reps beyond that (see below).
> **Known limit** (a sampling limit, not a threshold one): at 15 fps with extremely short kicks (each under ~100 ms) the sampler may miss
> the peak entirely — raising the camera frame rate helps more than moving the line.
> Counter-examples (**must stay at 0**): jogging in place (150° knee), a fast jog's knee lift (133°), and both legs bending in phase
> (including bouncing together).
>
> `tests/test-detectors.mjs`'s `[7c]` section pins this down with **real frames** (five cadences from 1000 ms to 430 ms per cycle, a
> 15 fps feed, a support leg that never straightens, shallower kicks and added noise — all must reach ≥90%, both counter-examples must
> count nothing, and the 115°/133° boundaries are pinned separately), and `tests/test-engines.mjs` adds “a single-frame spike (finished
> inside 33 ms) still counts”, “the same leg kicking repeatedly never inflates the count” and “both legs entering on the same frame is
> not an alternation”.
>
> ⚠️ **A modelling trap worth remembering**: the test helper that bent a shin originally worked in **normalized** coordinates, and the
> 16:9 aspect ratio scales those angles by nearly a factor of two — so “the support leg is only bent 35°” was really **126°** (a deep
> squat) in true geometry, which made the models far stricter than reality and misled the threshold tuning. All shin bending now goes
> through `tests/synthetic-pose.mjs`'s `foldShin()` (which folds in **metric space**, so folding by X° yields a knee angle of 180−X°).
>
> **Its standing gate is the floor-independent one** (`standUpright`): only “trunk tilt ≤ 52°” plus “shoulders at least
> 0.5× torso length above the hips”. The user reported “I *was* standing, my trunk tilt is only a few degrees, but it keeps saying
> I am not standing” — the regular `stand` gate also demands “knee ≥ 0.28 and hip ≥ 0.55 torso lengths off the floor”, and both of
> those are measured from the **calibrated floor line**: once that line drifts (feet out of frame, or the calibration caught you out
> of position) a perfectly upright stance can never pass. “Shoulders above hips” compares the body with itself — about +1.0× torso
> length standing, about 0 lying down — so it still tells the two apart while being completely independent of where the floor line
> happens to be.
>
> ⚠️ **That gate hit a sign trap — written down here so it never happens again**: image y grows downwards, so “shoulders above hips”
> is the **positive** quantity `shoulderAboveHip = (hip.y − shoulder.y)/torsoLen` (≈ **+1.0** standing), while the older “hip lift” is
> its exact negative `hipRise = (shoulder.y − hip.y)/torsoLen` (≈ **−1.0** standing, and only the glute bridge uses it).
> The gate was first written as `hipRise ≥ 0.5` — which demands the hips half a torso *above* the shoulders (practically a
> headstand) — so no matter how correctly you stood, the gate could never pass and the app kept saying
> “**you're not in position for this move yet**” (exactly what the user reported). The gate now uses the positive
> `shoulderAboveHip`, and `tests/test-detectors.mjs` carries **real-frame** baseline checks (synthetic pose → `computeFrame`):
> standing must give `shoulderAboveHip ≈ +1.0` and `hipRise ≈ −1.0`, lying down must be blocked. The older hand-written frames had
> encoded the same mistake as the code, so a fully green suite could not catch it.
> The 🐞 metrics panel prints **both** numbers (“Hip lift” / “Shoulders above hips”, exact negatives of each other), so any future
> “it says I'm not standing” report can be read straight off those two lines.
>
> **It is “timed counting” too** (the user asked for one minute of butt kicks to see how many you can do) — a fixed 60 seconds that
> settles automatically, with the result being the number of kicks inside those 60 seconds. The rep rule, keyframes, criteria and
> points are untouched; the details are in the [timed counting](#timed-counting-jumping-jack--butt-kick-a-fixed-60-seconds-see-how-many-you-can-do) section above.

### Sound and voice feedback

| Moment | Feedback |
|---|---|
| A form step is hit | **A single rising chime** + a `+12` point animation floating up on screen |
| Every form step in the round complete | A three-note rising “perfect round” chord + floating points |
| First time you hit each form step | **The form step is spoken aloud**; repeats only chime, no voice, so it never floods your ears |
| Every 50 points crossed | A rising cue tone + **an encouragement spoken aloud** (never the score) + a subtitle reading “N points already!” |
| Valid rep +1 | A pentatonic rep tone + a spoken rep count |
| Every 3 reps (every 5 on fast exercises) | **An encouragement** (24 rotating lines: keep going / great job / excellent / you are crushing it …) |
| Every keyframe in a round cleared | The perfect-round chord + floating text, then a cheer about 0.9 s later (perfect! / full marks, beautiful …) |
| A rep doesn't count | A low “pff” sound + a subtitle pointing out the problem |
| Holding in a timed exercise | A soft tick every second + the score climbing steadily on screen |
| **Every 5 seconds while holding** | **The elapsed seconds are spoken — “5 seconds”, “10 seconds”, …** (plank, side plank and the folds alike), and the on-screen seconds pulse in step |
| Goal reached / set ended | A celebration chord + goal floating text + a summary panel (score plus any form steps you missed); the voice says only “that set: N reps” plus a cheer |

Both sound effects and voice can be turned off with one click in the ⚙️ Settings dialog.

> **Counting out loud in timed exercises**: a timed exercise like the plank **speaks the elapsed seconds every
> 5 seconds** (“5 seconds”, “10 seconds”, “15 seconds” …). It reads the detector's own accumulated hold time, so
> pausing (your form collapsed) and resuming continues the count instead of starting over, switching exercise or
> resetting the counters re-arms it at 5 seconds, and a jump of several steps (a long interruption) only reads the
> current one — never a burst of numbers. When a form-step line such as “hold steady for 10 seconds” lands in the same
> frame, **the count wins** (the step still scores, ticks and chimes, it just isn't spoken) so the two never talk over
> each other. With the voice switched off nothing is said, but the on-screen seconds still pulse.

---

## Languages

Chinese and English are built into the interface. Switch any time with the **Language** dropdown in the top-right corner — your choice is remembered:

| Language | Code | Locale file |
|---|---|---|
| 中文 | `zh` | `src/locales/zh.js` |
| English | `en` | `src/locales/en.js` |

The first time you open it, the language is picked from your browser language (Chinese for Chinese, everything else falls back to English).

> Spanish and French used to be included as well; they were removed to keep development light (Chinese and English only).
> The entry structure is still there, so adding a language back is just the steps below.

**Adding a language**: copy `src/locales/en.js` and translate it, import it in `src/i18n.js` and add it to `LOCALES` and `LANG_ORDER`,
then run `npm run test:i18n` again — the test checks every entry for missing keys, untranslated strings, placeholders and array lengths, so nothing slips through.
The language dropdown in ⚙️ Settings picks it up automatically; the README list in `tests/test-i18n.mjs` needs one manual line.

---

## Can't fit into the outline or getting no response? Four checks

**① Check the version first.** The page title should show `v3.0` next to it. If you don't see it, the browser is still running a cached old version — force a refresh with **Ctrl + F5** (Cmd + Shift + R on Mac).

**② Look at the “Pre-workout calibration” panel on the right first.** Whichever of the seven checks isn't ticked (only “body detected” and “whole body in frame” actually block the start), do what the line under the panel tells you:

| Panel message | Meaning |
|---|---|
| Can't make out your whole body: back up a little… | The model can't find you, or a body part is out of frame |
| You're too far from / too close to the camera: step forward / back up a little | Your body is the wrong size in the frame |
| Shift a little to the right / to the left, into the middle of the outline | You're not centered left to right |
| Move a little higher / lower in the frame | Your vertical position is off |
| Face the camera / turn sideways to the camera | The camera angle doesn't match the current exercise |
| Nice — hold still… | You're one second away from being done |

**③ Then look at the status bar below the video** — it shows the same message in sync, and once training starts it shows “what step is next and how far off you are”.

**④ Turn on “🐞 Metrics” in the top-right corner** (it works during calibration and during training). The numbers the detector sees are listed live below the video, for example:

```
View Side ✓(0.18) · Full body ✓ · Both legs visible ✓ · Trunk lean 6° · Knee 176° · Elbow 172° ·
Hip 172° · Body line 175° · Hip lift -0.98 · Shoulders above hips 0.98 · Thigh from horizontal 88° ·
Visibility 0.94 · Outline ✗ · State running
```

Read them like this:

| Symptom | Cause | Fix |
|---|---|---|
| `View Side ✗(0.90)` | The camera angle doesn't match what this exercise needs (the five front-facing exercises want you facing the camera, everything else wants the side) | Turn as the status bar says: face the camera for Bodyweight Squat / Sumo Squat / Squat Jump / Box Jump / Burpee, sideways for the rest |
| `Full body ✗` | Some body parts are out of frame | Back up 1–2 steps so you're in frame from head to feet |
| `No person detected` | Too far / too close, backlighting, or a background the same color as your clothes | Move closer, face the light source, change clothes, or use a higher-resolution camera |
| `Trunk lean` stuck above 32° | The camera is tilted or you're standing crooked | Straighten the camera (or level it with a book) |
| The butt kick keeps saying “you're not in position for this move yet” | Its standing gate watches “shoulders above hips” | Look at **`Shoulders above hips`**: standing it should read **≈ +1.0** (with `Hip lift ≈ −1.0`). If it is near 0 or negative you really are lying down / folded over; if both lines look right and the exercise still refuses to start judging, that is a bug — read the line out to me |
| The numbers look fine but nothing gets checked off | You're stuck right on a step's threshold | The status bar spells out exactly how far off you are (for example, “your squat depth is now at 62% (100% = thighs level)”) |
| `Outline ✓` while `State running` | This should never happen (the outline must be gone once you're recognised) | Note the state and the exercise and report it — a hard guard plus a frame-by-frame test cover the three workout states, so seeing this would be a new bug |

---

## FAQ

**Q: What if port 4174 is already in use?**
Just start it on another port: `PORT=8080 node preview-server.js` (on Windows, `$env:PORT=8080; node preview-server.js`).
To see what's holding it: on macOS/Linux use `lsof -i :4174`; on Windows use `netstat -ano | findstr 4174`.

**Q: The browser says "camera unavailable / NotAllowedError"?**
Turn on both the system-level and browser-level permissions as described in “Camera permissions” above, then **quit the browser completely and reopen it**.

**Q: The page says "couldn't load the pose model"?**
That's almost always the wrong MIME type for `.wasm`. The bundled `node preview-server.js` is the most reliable route; with Python you need 3.9+.
Also make sure the `vendor/` directory is complete (when you download the ZIP from GitHub, forgetting to unzip the whole directory is the most common slip).

**Q: The video stutters / the frame rate is low?**
Switch “Model” to **Lite** and turn off “📐 Angles” in ⚙️ Settings; try a faster device. Tracking still works fine at 10–15 FPS.

**Q: Does it work on a phone?**
Yes. Open the same address in your phone's browser (the phone and the computer need to be on the same local network, and the server has to listen on `0.0.0.0`:
change `'127.0.0.1'` to `'0.0.0.0'` in `preview-server.js` and restart). Note that this also lets anyone else on the same network reach it.

**Q: Where is the data stored?**
Workout history and best scores live in the browser's localStorage, so they're lost if you switch browsers or clear your cache — and they're never uploaded to any server.

---

## Tests

```bash
npm test                       # run all six suites (1614 cases)
npm run test:i18n              # i18n: missing keys / untranslated strings / placeholders / array lengths / leftover Chinese in source / matching structure of the Chinese and English READMEs
npm run test:detectors         # detection and scoring logic of the five hand-written detectors (driven by synthetic skeletons)
npm run test:engines           # the generic detection engines (bend / alternation / twist / multi-stage / timed + posture gating)
npm run test:specs             # the keyframe criteria shown in the modal must equal the lines the detectors actually use
npm run test:dump              # also prints baseline posture metrics, handy for tuning thresholds
npm run test:page              # page wiring self-check (DOM ids / module imports / static assets / exercise catalogue and category lists)
npm run test:app               # integration test that loads the real app.js with a minimal DOM stub
```

| Test file | Cases | Coverage |
|---|---|---|
| `tests/test-i18n.mjs` | 18 | Identical key structure across Chinese and English, no untranslated strings, matching placeholders and array lengths, no hard-coded Chinese left in the source, and a consistent structure across both READMEs |
| `tests/test-detectors.mjs` | 349 | Rep counting, hold timing, form-step scoring and scoring order for correct reps and every kind of incorrect rep, depth judging under an angled camera, the pre-workout calibration checks, the **sign baseline for the standing gate (butt kick) on real frames** (standing gives `Shoulders above hips ≈ +1.0` and `Hip lift ≈ −1.0` and passes the gate; lying down or standing on your head is blocked), **butt-kick counting across speeds** (real frames through the real pipeline: 1000 / 700 / 600 / 500 / 430 ms per cycle must all reach ≥90% of the expected reps, a 15 fps feed must still count, and a support leg that never straightens / shallower kicks / added noise are all accepted; counter-examples: jogging without kicking and both legs bending in phase must count nothing; boundaries: a knee reaching ~115° counts while one only reaching ~133° does not — the relaxed-mode trade-off), **the glute bridge's OR criterion** (the user's low lift height with a 170° hip angle at the top must count ≥4 reps, a half bridge at 160° must not reach the top, and a “safety rope” run with the height path's top line made unreachable must count nothing), **the loosened push-up counting line** (an elbow bottoming out at 145° must count ≥4 reps where it used to count none, a case at 148° with only a 0.079 shoulder drop still counts nothing, and a flattened elbow reading of 152°→140° accompanied by a real body drop still counts), plus **the push-up counting at the bottom** (the count lands in the 0.42-0.68 phase of the cycle with the elbow still deep, and holding at the bottom does not farm reps), **the plank's "propped up" rule** (a low ground line measuring the hands at 0.68 still times, lying flat resting at a 10° shoulder angle does not, and the old ground-line rule still works as the fallback), the agreement between “the progress-bar chain finished” and “a rep was counted” (at most 250 ms apart), and the “is this frame a person?” visibility thresholds (after loosening: hands out of frame or a hidden face/fingers still count as a person, a dim room is fine down to 0.10, and collapsed degenerate frames are rejected) |
| `tests/test-engines.mjs` | 198 | The generic engines: one rep per cycle, the single relaxed tier (there is no strict mode), the boundaries for wobbles and speeding, posture gating (including the lying leg raise taking either of two "lying down" signals, and the butt kick gate judging “shoulders above hips” rather than “hip lift”), feet off the floor when jumping, left/right alternation (including the butt kick: one kick on each leg is one rep, **a single-frame spike finished inside 33 ms still counts**, the same leg kicking repeatedly never inflates the count, both legs entering on the same frame is not an alternation, the `switched` flag, the “the other side is not kicking too” alternation rule, and the 🐞 diagnosis rows listing both legs plus the alternation lines; plus the **redesigned dead-bug criteria**: kicking only the shin straight (foot to the ceiling) does not count, a leg lowered with the knee still bent does not count, both legs extending together does not count, a leg that never quite reaches the floor (`legOut ≈150°`) still counts, six rapid switches lose no reps, and the diagnosis rows expose `legOut` plus the “other leg ≤120” rule), whole sequences, and pausing/resuming the timer |
| `tests/test-specs.mjs` | 781 | Feeds the numbers shown in the modal back into the detectors: they must land exactly on the detector's own counting lines (including the push-up's four shoulder-drop thresholds being ordered `start < close < count < full`, and its four elbow tiers `top > start > count > full depth`); posture-gate numbers come from the same table used for judging (the lying leg raise proves “lying down” with “trunk close to horizontal or shoulders ≤ 0.6× torso off the floor”, either one, and the dead bug does the same); all 20 exercises have thresholds; every segment of the counting chain is a condition for counting (the last segment *is* the counting moment, and depth/timing criteria stay off the bar); for the engine-driven exercises that last segment is the engine's own return line (never a trivially-true stub); the keyframe line icons match the criteria (including the standing butt-kick figures) and the counting segment is never merged away; the bar is walked through with synthetic poses (a shallow movement never reaches the last segment); both languages are complete |
| `tests/test-page.mjs` | 367 | DOM wiring, module imports and exports, static assets, the category lists of all 20 exercises (including “jump squat under Full body, butt kick under Lower body”) and the completeness of their scoring plans, the timed-counting declaration (`isTimedReps` / target unit in seconds / result unit in reps / exactly the jumping jack and the butt kick / the “timed counting” wording in both languages), plus the style assertions behind “the score sits under the count in its own gold colour”, “the trunk tilt is labelled like Hip / Knee”, “the two knees are labelled separately” and “a state change never moves any geometry, so the bar cannot jitter” |
| `tests/test-app.mjs` | 489 | Startup with the real `app.js`, home-page rendering, both the exercise-settings (keyframe criteria and scoring included, with the bridge row required to read “height **or** hip angle ≥ 165°” and the push-up row “plank → back at the top → start lowering → the bottom counted (146°/0.08)”) and settings modals, the judgement progress bar (grey/coloured states, segment-by-segment lighting, hover showing the criterion, the reset after a completed round, and the butt kick's three segments with the last one lighting at the moment of the switch), the calibration flow, exercise switching, scoring, sound, the set summary, Chinese/English switching, timed counting (both the jumping jack and the butt kick: seconds target and its own storage, the remaining-time calls at 45/30/15/5, time-up stopping the count and the clock, a 100% time-based summary, records written as “N reps / N s”, and normal rep exercises never ending on a clock), fullscreen (the video frame is what gets enlarged, going home leaves fullscreen, ending a set alone does not, and no fullscreen API call happens when you were never fullscreen), the layout assertion that the score sits directly under the count, the on-screen angle labels (Hip / Knee / left and right knee / trunk tilt, including the ones the seated forward fold now prints), and the dashed outline's timing **through the real main loop** for all 20 exercises (drawn when nobody is found, drawn until you're in position, not a single frame during recognition success / countdown / counting / paused, and back again once you drift out of position) |

---

## Project structure

```
motion-fitness-game/
├─ index.html            page structure (all copy goes through data-i18n)
├─ style.css             dark UI styling
├─ preview-server.js     zero-dependency local server (http://127.0.0.1:4174)
├─ src/
│  ├─ i18n.js            ★ i18n core (t / setLang / applyI18n)
│  ├─ locales/           ★ the two locale files: zh.js / en.js
│  ├─ catalog.js         ★ the exercise library: five categories + 20 exercises (icon, type, engine, thresholds, judging basis)
│  ├─ geometry.js        geometry and signal processing (angles, One Euro smoothing)
│  ├─ metrics.js         per-frame exercise metrics (joint angles, hip lift, floor clearance, body straightness…)
│  ├─ steps.js           ★ the scored form steps per exercise (condition + points + hint key)
│  ├─ calibration.js     ★ pre-workout calibration: dashed body silhouette outline + the seven positioning checks
│  ├─ detector-base.js   detector base class (form-step scoring, cue throttling, dropped-frame handling)
│  ├─ engines.js         ★ the generic detection engines (bend / alternation / twist / multi-stage / timed + posture gating)
│  ├─ exercises.js       ★ the five hand-written detectors (Bodyweight Squat / Forward Lunge / Push-up / Glute Bridge / Plank) + factory
│  ├─ pose-engine.js     MediaPipe PoseLandmarker wrapper + camera management
│  ├─ render.js          skeleton rendering
│  ├─ audio.js           sound effects + speech (follows the selected language)
│  └─ app.js             UI, exercise home page, settings modal, workout flow, form-step checklist, records, main loop
├─ tests/                the six automated test suites
└─ vendor/               MediaPipe tasks-vision (wasm) and the pose model (offline)
```

---

## Tuning scores and thresholds yourself

**Adding an exercise takes one config entry in the exercise library** (no detection code to write):

1. Add one entry to `EXERCISES` in `src/catalog.js`, for example
   `e('myMove', '🔧', ['core'], { plan: 'repSupine', posture: 'supine', judge: 'clear', target: 15, params: bend({ metric: 'kneeClear', gate: 'supineLow', up: 0.15, down: 0.85 }) })`;
2. Add `myMove: { name, cameraHint, goal }` to the `ex` block of both `src/locales/*.js` files
   (the form steps and tips automatically fall back to the template of the “family” it belongs to — add `howto` / `tips` if you want to write your own);
3. Run `npm test` — the tests check the five category lists, the copy in both languages, and that every exercise has both a detector and a complete scoring plan.

- **Change point values or form-step wording**: edit `src/steps.js` (structure and points) and `src/locales/*.js` (wording).
  Each step is one `{ id, labelKey, points, check, hint }`; when `check(frame, det)` returns `true`, that step counts as hit.
- **Change the judging thresholds**:
  - **Exercises on the generic engines** (the large majority of the library): edit that exercise's `params` in `src/catalog.js` —
    `metric` picks which quantity to use (`kneeBent` / `elbow` / `hipRise` / `kneeClear` / `shoulderClear` …),
    `gate` requires a posture (`stand` / `prone` / `supine` / `seated` / `sideLying` …),
    `up` is the start value, `down` the target value, `looseP` the lenient counting line, `minRepMs` the fastest time for one rep, and `flight` whether both feet have to leave the floor;
  - **The five hand-written detectors**: edit the matching constants in `src/exercises.js` (they all have Chinese comments) —
    `SQUAT_FRONT` (in `src/steps.js`): `standRatio` 0.86 / `enterRatio` 0.78 / `bottomRatio` 0.40 /
    `looseRatio` 0.62, measured as “how much higher your hips are than your knees ÷ shin length”, standing tall ≈ 1.0;
    `LUNGE`: `enterKnee` 146 / `looseKnee` 142 / `downKnee` 128, the three knee-angle levels, with `backKneeDrop` 0.66;
    `enterHoldMs` / `exitHoldMs` are the jitter tolerances;
    `PUSHUP`: `looseElbow` 146 (counting line) / `elbowEnter` 150 (start line) / `elbowUp` 156 (reference top) /
    `elbowFull` 128 (full-depth line) / `minBend` 8 (wobble filter) / `enterDrop` 10 (how far below your top starts a rep) /
    `dropStart` 0.05 < `dropReturn` 0.06 < `dropMin` 0.08 < `dropFull` 0.26 (the four shoulder-drop thresholds);
    `BRIDGE.upRise` 0.22, `liftAngle` 150, `topAngle` 165 (the hip-angle side criteria for lift / top) and `minRepMs` 420;
    `PLANK.bodyStraight` 142;
  - `HoldDetector.graceMs`: the grace period for timed exercises (default 1200ms).
  - **The “is this frame a person?” thresholds** (top of `src/metrics.js`, loosened after user feedback):
    `PERSON_VIS_MEAN` 0.10 (average visibility of the core joints), `PERSON_VIS_MIN` 0.02 with `PERSON_VIS_SLACK` 2
    (two of the 15 judging points may be invisible; from the third one on, visibility must be ≥ 0.02), and `PERSON_MIN_TORSO` 0.02
    (torso length at least 2% of the frame height, which keeps collapsed degenerate frames out). `src/calibration.js` reads the same
    `PERSON_VIS_MEAN`.
  - **One relaxed tier only**: `DetectorBase` no longer has a `strict` switch at all (roughly doing the movement counts; poor form
    only triggers a spoken correction plus a quality discount); the one counting rule left is that the keyframe chain on the progress bar is fully lit.

After changing anything, run `npm test` — the tests have the standard range of motion for these exercises baked in, so they'll tell you right away if you've tightened things too far.

**How the tracking works**: every criterion uses only **angles** and **ratios divided by torso length**, so it's independent of your height and how far away the camera is;
landmarks are first corrected for the frame's aspect ratio before angles are computed, and a One Euro filter suppresses jitter — so one set of thresholds fits different people and different camera positions.

---

## Privacy and license

- Video is processed only in your local browser, and **nothing is uploaded**; the model and wasm are local files, so it works offline.
- The server listens only on `127.0.0.1` by default, so no one else on your network can reach it.
- Workout history lives only in your own browser's localStorage.
- Third-party resources: MediaPipe Tasks Vision (wasm) and the Pose Landmarker model under `vendor/` come from Google MediaPipe and are licensed under the **Apache License 2.0**.
