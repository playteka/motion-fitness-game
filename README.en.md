# Motion Fitness Game

[中文](README.md) · [English](README.en.md)

A small fitness game that uses an ordinary webcam for motion tracking: **22 exercises** split into five categories — **Upper body / Lower body / Core / Full body / Stretching**,
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
- [Settings modal (language / model / sound)](#settings-modal-language--model--sound)
- [Pre-workout calibration](#pre-workout-calibration)
- [How to use it (camera angle matters)](#how-to-use-it-camera-angle-matters)
- [Exercise library overview (22 exercises)](#exercise-library-overview-22-exercises)
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

- **Exercise home page (five categories)**: you land on a wall of exercises split into **Upper body (3) · Lower body (7) · Core (6) · Full body (5) · Stretching (2)**,
  and each exercise is one card (icon + name + reps/timed + target + judging basis), with a search box as well. Click a card to open its exercise page, and the 🏠 icon in the top-left corner brings you back any time.
  “Jump Squat” is listed in two categories at once (either card opens the same exercise).
- **Exercise page + settings modal**: the exercise page has ⚙️ Settings in the top-right corner, and the modal collects **language, detection model, sound effects, spoken counting and background music**
  together with mirror, strict mode, skeleton, angles and metrics toggles — no more hunting for buttons all over the screen.
- **Pre-workout calibration**: before you start there's a **dashed body silhouette** in the frame (it only traces your outer shape — you don't need to line up your joints), and a text prompt above the video tells you
  “move into the dashed outline”; **as long as a body is detected and your whole body is in frame you're cleared to start** (about 0.6 seconds), while
  distance, centering, height, camera angle and holding still are only recommendations (marked with “·” in the panel) and no longer block the start.
- **Form steps scored one at a time**: each exercise is broken into 4–5 judgeable steps — hit one and you immediately get points, a chime, and a checkmark;
  finishing every step in a round earns a perfect-round bonus, and hold exercises give **+1 point for every second you hold**.
- **Valid rep detection (lenient by default)**: **if you roughly did the movement, it counts** — shallower squats and lunges, push-ups that only go part of the way down and glute bridges that don't rise very high all count, while the voice coach corrects “go lower / down a little more / lift your hips higher / don't let your lower back sag” and the score is discounted for quality; turn on the **Strict mode** switch in the settings modal if you want “only a full-depth rep counts”. Movements you didn't really do (a mere wobble) aren't counted and won't trigger nagging.
- **Every exercise states its “judging basis”**: the card and the exercise page spell out what the exercise is judged by (elbow bend / knee bend /
  hip lift height / both feet off the floor / body posture …), and exercises the camera can't judge reliably are additionally marked as **rough scoring**.
- **Live status feedback**: the area below the video always shows what state you're in, which step you're stuck on, and how many degrees you still need.
- **🐞 Metrics panel (with “Rep diagnosis”)**: besides the raw numbers (view, visibility, joint angles), the first line is a **rep diagnosis** —
  which stage the detector is in, the line it needs you to come back to for a rep to count, this rep’s minimum/peak, and **why the last attempt was not counted**
  (too shallow / too fast / too little range …). If counting looks wrong, read that line out and we can pinpoint it instead of guessing.
- **Spoken counting in the selected language + sound effects**: hitting a form step plays a rising chime, the first time you hit a step it's spoken aloud, and your score is announced every 50 points.
- **Motivation first, guidance moderate**: **every rep is spoken aloud**, every 3 reps you get an **encouragement**
  (“Keep going / Great job / Stay with it / Nice work / Hold that form / Excellent”, rotating so it never repeats), and hitting your target celebrates you before adding another cheer;
  form corrections are kept but run much less often (the same line is not repeated within 15–30 s, and less often once you are a few reps in), and “what comes next” is slowed to one line every 9 s
  — the airtime goes to counting and encouragement, so you barely need to watch the screen.
- **🎶 Four selectable background tracks**: all synthesised live (no space taken, no internet needed) — pick one under “🎵 Background track” in the settings:
  **City Run** (132 BPM, light and swinging) / **Neon Pulse** (144 BPM, four-on-the-floor electronic) / **Sunrise Funk** (122 BPM, funky syncopation) / **Power Drive** (152 BPM, driving rock).
  The drum kit is really synthesised (kick, snare, hats, claps), so the rhythm is much punchier than before, and the music ducks automatically while the coach is speaking.
- **🦴 Skeleton toggle**: hide the skeleton overlay and keep just the camera view; the angle labels toggle independently.
- **Goal progress ring, best scores and workout history** (saved locally in your browser).
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
front-facing exercises (Bodyweight Squat / Sumo Squat / Jump Squat / Box Jump / Burpee) use a front-on standing silhouette, and the other standing exercises use a side-on standing pose,
push-up exercises (Mountain Climber included) use a **side-on top-of-the-push-up position** (arms straight, hands on the floor), Plank and Side Plank use a **side-on forearm-supported prone position**,
and lying-down exercises like Glute Bridge / Crunch / Lying Leg Raise / Dead Bug use a **side-on lying pose with bent knees** (on your back, knees bent, feet flat on the floor).
When you film from the side, the outline flips left to right automatically to match which way you're facing.

Once the two mandatory checks pass and stay that way for about 0.6 s, the **dashed outline disappears at once** (that is the signal that your whole body has been recognised),
and the 3-2-1 countdown then fires automatically to start counting — there is no button to click.
When a set ends you go back to calibration: this time the outline stays green, and you start the next set yourself with “Start set” (or Space) —
so you can rest and look at the summary first instead of being pulled straight into the next set.

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
- **🎯 Exercise settings** (shown on the exercise page only, side by side with ⚙️): one modal gathers this exercise's target and
  judging rules — the set target (number box plus preset buttons), the counting rule (relaxed / strict, the very same switch as in ⚙️),
  this exercise's **judging basis**, its **camera hint**, and the **📐 counting thresholds** below.
  The “② Set target” card in the side panel keeps just a one-line target readout, and its button opens the same modal.
- An exercise that belongs to two categories (Jump Squat) appears in both blocks, and either card opens the same exercise.

## 📐 Counting thresholds (inside the exercise-settings modal)

The exercise-settings modal of every exercise lists **the rules the detector is using right now**: how far a rep has to go to count,
what counts as full depth, what is treated as a mere wobble, where the rep has to return to, and what posture is required.

Take the lunge (the numbers are the constants in the code):

| Group | Threshold | Rule |
|---|---|---|
| Counting | Counts as one rep (relaxed mode) | Front knee bend ≤ 152° |
| Counting | Both knees must bend (the straighter leg) | ≤ 158°, or 12° below your own standing angle |
| Counting | Full depth (earns full depth points) | Front knee bend ≤ 128° |
| Counting | Back to the start position (rep ends) | Rise 60% of the way back from this rep’s deepest point, or 8° above it |
| Counting | Shortest rep time | ≥ 0.45 s |
| Posture | Standing position | Trunk tilt ≤ 52°, knee height off the floor ≥ 0.28× torso, hip height ≥ 0.55× torso |
| Form reminder | Back knee close to the floor (spoken only, never costs reps) | Back-knee height off the floor ≤ 0.66× shin |

> **These numbers are not a separate write-up — they are read out of the constants the detector actually uses** (see `src/specs.js`):
> the hand-written detectors read the threshold tables `SQUAT / LUNGE / PUSHUP / BRIDGE / PLANK`, the generic engines read each
> exercise's `up / down` and `enter / bottom / loose / ignore` progress from `catalog.js`, the posture gates read `GATE_LIMITS`
> in `engines.js` (the very same table used for judging), and the timed exercises read `HOLD_PRIME_MS / HOLD_GRACE_MS`.
> Change a threshold and the modal follows automatically, so the screen can never claim something the detector does not do.
> `tests/test-specs.mjs` feeds these numbers **back into the detectors** on every test run: a displayed counting line has to land
> exactly on the detector's own progress line (379 assertions).

## Settings modal (language / model / sound)

Open the ⚙️ settings modal from the top-right corner of the exercise page — every switch is gathered in there:

| Group | Items |
|---|---|
| Language | 中文 / English (takes effect immediately, switching exercise names and form steps along with it) |
| Pose model | Lite (smoother, the default) / Full (more accurate; the first switch has to download one more model file, and it's offline after that) |
| Sound | 🔊 Voice count · 🎵 Sound FX · 🎶 Music |
| Video & tracking | 🪞 Mirror · ✅ Strict mode · 🦴 Skeleton · 📐 Angles · 🐞 Metrics |

Click outside the modal, or press `Esc` or `G`, to close it.

> **Angle labels are never mirrored**: with 🪞 mirror preview on, both the video and the canvas are flipped left-to-right,
> which would also flip the “Knee 132°” / “Elbow 118°” labels drawn on the canvas. The renderer flips itself back the other way,
> so joint angle readouts stay readable while mirroring is on.

---

## How to use it (camera angle matters)

**Front-facing camera: Bodyweight Squat, Sumo Squat, Jump Squat, Box Jump and Burpee; every other exercise is done sideways to the camera.**
The first line of “Form steps” on the exercise page spells out how to stand for that exercise (and every card also states its judging basis).

- **Front-facing exercises** (Bodyweight Squat / Sumo Squat / Jump Squat / Box Jump / Burpee): face the camera. Depth is judged by “how much higher your hips are than your knees”,
  a quantity that isn't compressed in a front view; and only a front-on view shows whether your knees are caving inward and whether your left and right sides are symmetric.

- Stand **2–3 m (6–10 ft)** away from the camera with your **whole body in frame** (head to feet);
- **Lunge / Bulgarian Split Squat**: stand sideways to the camera so your ankles, knees, hips and shoulders are all visible at once;
- **Push-up / Plank / Mountain Climber**: your body runs perpendicular to the lens, with both hands and both feet inside the frame;
- **Glute Bridge / Crunch / Lying Leg Raise / Dead Bug / Side Plank**: lying down, sideways to the camera, with your shoulders, hips, knees and ankles all visible at once;
- **Stretching**: for Standing Forward Fold, stand up straight sideways to the camera; for Seated Forward Fold, sit on the floor sideways to the camera;
- Even lighting, a clean background, and closer-fitting clothes all make tracking more stable.
- **No sound?** ① check the browser tab is not muted (speaker icon on the tab) ② open settings and flip “🔊 Voice count” once — it speaks a short test line right away ③ open “🐞 Metrics”: the last line shows “Sound” as `running` with a voice count above 0.

**Note the flow: pick an exercise → move into the dashed outline → your whole body is recognised (the dashed outline disappears) → automatic 3-2-1 countdown → counting starts;
after a set ends you go back to calibration, and you click “Start set” (or press Space) to start the next set.**
Calibration only checks that you're in position — it never counts reps or awards points.

**Shortcuts**: `1`–`9` switch exercise · `H` home · `G` settings · `Space` start/pause · `R` reset reps · `Esc` end set · `M` mirror · `S` skeleton · `F` fullscreen the video frame

---

## Exercise library overview (22 exercises)

| Category | Exercise (icon) | Type | Judging basis | Default target |
|---|---|---|---|---|
| 💪 Upper body | Push-up 💪 | Reps | Elbow bend | 12 reps |
| 💪 Upper body | Wide Push-Up ↔️ | Reps | Elbow bend | 12 reps |
| 💪 Upper body | Diamond Push-Up 💎 | Reps | Elbow bend | 10 reps |
| 🦵 Lower body | Bodyweight Squat 🏋️ | Reps | Knee bend (front-on depth) | 15 reps |
| 🦵 Lower body | Sumo Squat 🤼 | Reps | Knee bend | 15 reps |
| 🦵 Lower body | Bulgarian Split Squat 🦵 | Reps | Knee bend | 12 reps |
| 🦵 Lower body | Forward Lunge 🚶 | Reps | Front knee angle + back knee height | 16 reps |
| 🦵 Lower body | Reverse Lunge ↩️ | Reps | Knee bend | 16 reps |
| 🦵 Lower body | Glute Bridge 🌉 | Reps | Hip lift height | 15 reps |
| 🦵 Lower body | Jump Squat 🚀 | Reps | Knee bend + both feet off the floor | 12 reps |
| 🔥 Core | Plank 🧘 | Timed | Hold time | 45 sec |
| 🔥 Core | Side Plank 🧎 | Timed | Whether your body position is on target (rough scoring) | 30 sec |
| 🔥 Core | Dead Bug 🐞 | Reps | Left/right leg alternation | 16 reps |
| 🔥 Core | Crunch 🌀 | Reps | Shoulder height off the floor | 20 reps |
| 🔥 Core | Reverse Crunch 🔃 | Reps | Hip hinge | 15 reps |
| 🔥 Core | Lying Leg Raise 🦿 | Reps | Hip hinge | 15 reps |
| 🤸 Full body | Burpee 💥 | Reps | Order of the whole sequence (squat → plank → jump) | 10 reps |
| 🤸 Full body | Mountain Climber ⛰️ | Reps | Left/right leg alternation | 24 reps |
| 🤸 Full body | Box Jump 🦘 | Reps | Knee bend + both feet off the floor (rough scoring) | 10 reps |
| 🤸 Full body | Jump Squat 🚀 | Reps | Knee bend + both feet off the floor | 12 reps |
| 🤸 Full body | Jumping Lunge ⤴️ | Reps | Knee bend + both feet off the floor | 14 reps |
| 🧘 Stretching | Standing Forward Fold 🙇 | Timed | Whether your body position is on target | 30 sec |
| 🧘 Stretching | Seated Forward Fold 🧎‍♂️ | Timed | Whether your body position is on target | 30 sec |

> “Jump Squat” belongs to both Lower body and Full body, and “Jumping Lunge” belongs to Full body — the same exercise can appear in more than one category.
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

> **A lunge doesn't require a 90° front knee**: bending the front knee to **152°** (about 20° down from standing) already counts, and
> the `enter`/`exit` lines both follow **how straight you personally stand** — compressed readings (standing tall reading only 140°)
> don't cause bogus counts, and deep squatters don't lose reps. The “too fast” check only applies to rounds where you really sank down.

> **A lunge requires *both* knees to bend (no front-leg-only dipping)**: watching the front knee alone lets a quick front-leg dip score a rep.
> The detector now also tracks the **straighter leg (the back one)**: it has to bend to **158°** or less (or at least **12°** below how straight
> you personally stand, whichever is stricter) for the rep to be valid. Moving only the front leg is logged as a partial rep and the voice coach
> says “Bend both legs: the back leg has to bend and sink too”. A back leg that bends less but genuinely bends still counts — the lenient baseline stands.
> The 🐞 panel's “Both knees (back/line)” line shows this round's measured value and the line.

### Push-up (40 points per round)

| Form step | How it's judged | Points |
|---|---|---|
| ① Hands on the floor, body in one straight line | Push-up position + body line angle ≥150° + deviation ≤0.18 | +5 |
| ② Brace your core and bend your elbows to lower down | Elbow angle ≤138° | +7 |
| ③ **Elbows bent until your chest is near the floor (top-scoring step)** | Elbow angle ≤105° and the body still in one straight line | **+14** |
| ④ Press back up to nearly straight arms | Elbow angle ≥142° (after first lowering down) | +8 |
| 🎁 All form steps complete for the round | All 4 steps above hit within the same round | +6 |

> **The “return to the top” line follows *your* range (important)**: on a real camera the projection makes “arms straight / standing tall” read lower
> (a side-on push-up often reads only 140–150°). If the detector insists on an absolute 145/168° to close a rep, the rep never closes and
> every following rep is merged into it — **ten reps, one or two counted**. The start position is now the largest range you actually reached in the last 1.5 s,
> so coming back near your own top closes the rep; and if a rep gets stuck, it is force-settled after 9–12 s, so reps are never swallowed.
> Every rep exercise also shows a “Rep diagnosis” line in the 🐞 panel.: bending your elbows to **135° or less** and coming back up past **145°** counts as one rep
> (it used to require reaching 124° and returning all the way to 152°). A sagging or piked hip and a body that isn’t perfectly straight only trigger a **spoken correction plus a quality discount** — they no longer eat your reps;
> a shallow rep still counts but you get a “go lower” cue and fewer points. Only “you barely bent your elbows” (never below 146°) counts for nothing and stays silent.
> Strict mode (available in the settings) is what requires full depth.

> **It counts even when the camera can't see the floor (camera-angle compensation)**: with a laptop sitting on a desk and looking down,
> you simply can't see the chest touching the floor in the frame, and the 2D projection makes the elbow angle **read straighter than it really is**
> (even a full rep may only read 140°). So push-ups now have a second depth signal that doesn't depend on the elbow:
> **how far the shoulders dropped** (about 1.2× torso length at the top, down to roughly 0.5 at the bottom). A shoulder drop of
> **0.20× torso length** already counts as “the body really did get close to the floor”, **0.40×** earns full depth credit, and even
> “this rep has started” can be triggered by the shoulder drop. Either signal is enough, so any camera height works.
> The 🐞 panel shows the live “Shoulder drop” value.

### Glute Bridge (39 points per round)

| Form step | How it's judged | Points |
|---|---|---|
| ① Lie on your back with knees bent, feet hip-width apart and planted | Supine bent-knee position (shoulders on the floor, knees off it) | +5 |
| ② Squeeze your glutes and drive your hips up | Hip lift > 0.15× torso length | +6 |
| ③ **Lift until shoulders, hips and knees are almost in a straight line (top-scoring step)** | Hip lift > 0.35× torso length | **+14** |
| ④ Lower your hips back to the floor under control | Back down on the floor (after first lifting up) | +8 |
| 🎁 All form steps complete for the round | All 4 steps above hit within the same round | +6 |

### Plank (70 points per set, plus 1 point per second)

| Form step | How it's judged | Points |
|---|---|---|
| ① Forearms under your shoulders, push your body up | Shoulders off the floor + hands on the floor + legal elbow angle | +8 |
| ② Head, back, hips and ankles in one straight line | Body line angle ≥148° + no sagging, no piking | +12 |
| ③ Hold steady for 3 seconds | Held for a full 3 seconds | +10 |
| ④ Hold steady for 10 seconds | Held for a full 10 seconds | +15 |
| ⑤ Hold steady for 30 seconds | Held for a full 30 seconds | +25 |
| ⏱ For every second you hold | While your form is valid | +1/sec |
> **The plank is judged leniently**: the timer starts as soon as your body is roughly flat, your shoulders are off the floor and your hands or forearms are near the floor.
> A sagging or piked hip, a body that isn't perfectly straight and low knees only trigger a **spoken correction plus a quality discount** — they no longer pause the timer;
> only “you never got into a plank” (standing, lying flat) stops the clock. The same goes for the other hold exercises: small wobbles within the 1.2 s grace period do not interrupt.

### About the exercises that are not in this list

> This version of the exercise library was trimmed to the 22 exercises on the given list, and Static Glute Bridge isn't one of them — if you want it back,
> copy the `bridge` entry in `src/catalog.js`, change `kind` to `'hold'`, and run `npm test` once more
> (the detection engine and the scoring plan are both already there — see [Tuning scores and thresholds yourself](#tuning-scores-and-thresholds-yourself)).

### Generic “family” scoring plans

On top of the 5 hand-written plans above, the remaining exercises share 8 **family plans** (exercises of the same kind are judged by identical logic, only the thresholds differ):

| Family plan | Used by | Step structure |
|---|---|---|
| Standing bend | Sumo Squat, Bulgarian Split Squat, Reverse Lunge | Set up → bend your knees and sink → hit the target range → drive back to standing |
| Prone bend | Wide / Diamond Push-Up | Set up in one straight line → bend your elbows and lower → reach the target depth → press back up |
| Supine lift | Crunch, Reverse Crunch, Lying Leg Raise | Lie down → start the movement → lift all the way → lower back under control |
| Alternating | Dead Bug, Mountain Climber | Get into position → first tuck/extend → switch sides → keep the rhythm |
| Multi-stage | Burpee | Stand → squat and plant your hands → complete the middle stage → stand up and finish |
| Jump family | Jump Squat, Jumping Lunge, Box Jump | Stand → bend your knees and load → **both feet off the floor** → land with bent knees |
| Timed (posture) | Side Plank | Get into position → body in one straight line → hold 3 / 10 / 30 seconds |
| Timed (stretch) | Standing Forward Fold, Seated Forward Fold | Enter the stretch → breathe and relax → hold 10 / 20 seconds |

Timed family plans also give **+1 point for every second you hold**; if your form collapses for more than 1.2 seconds, the timer pauses and the voice reminds you.

### Sound and voice feedback

| Moment | Feedback |
|---|---|
| A form step is hit | **A single rising chime** + a `+12` point animation floating up on screen |
| Every form step in the round complete | A three-note rising “perfect round” chord + floating points |
| First time you hit each form step | **The form step is spoken aloud**; repeats only chime, no voice, so it never floods your ears |
| Every 50 points crossed | A rising cue tone + the score announced by voice + a congratulatory subtitle |
| Valid rep +1 | A pentatonic rep tone + a spoken rep count |
| A rep doesn't count | A low “pff” sound + a subtitle pointing out the problem |
| Holding in a timed exercise | A soft tick every second + the score climbing steadily |
| Goal reached / set ended | A celebration chord + goal floating text + a summary panel (score plus any form steps you missed) |

Both sound effects and voice can be turned off with one click in the ⚙️ Settings dialog.

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
Hip 172° · Body line 175° · Hip lift -0.98 · Thigh from horizontal 88° · Visibility 0.94 · State running
```

Read them like this:

| Symptom | Cause | Fix |
|---|---|---|
| `View Side ✗(0.90)` | The camera angle doesn't match what this exercise needs (the five front-facing exercises want you facing the camera, everything else wants the side) | Turn as the status bar says: face the camera for Bodyweight Squat / Sumo Squat / Squat Jump / Box Jump / Burpee, sideways for the rest |
| `Full body ✗` | Some body parts are out of frame | Back up 1–2 steps so you're in frame from head to feet |
| `No person detected` | Too far / too close, backlighting, or a background the same color as your clothes | Move closer, face the light source, change clothes, or use a higher-resolution camera |
| `Trunk lean` stuck above 32° | The camera is tilted or you're standing crooked | Straighten the camera (or level it with a book) |
| The numbers look fine but nothing gets checked off | You're stuck right on a step's threshold | The status bar spells out exactly how far off you are (for example, “your squat depth is now at 62% (100% = thighs level)”) |

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
npm test                       # run all six suites (1347 cases)
npm run test:i18n              # i18n: missing keys / untranslated strings / placeholders / array lengths / leftover Chinese in source / matching structure of the Chinese and English READMEs
npm run test:detectors         # detection and scoring logic of the five hand-written detectors (driven by synthetic skeletons)
npm run test:engines           # the generic detection engines (bend / alternation / twist / multi-stage / timed + posture gating)
npm run test:specs             # the counting thresholds shown in the modal must equal the lines the detectors actually use
npm run test:dump              # also prints baseline posture metrics, handy for tuning thresholds
npm run test:page              # page wiring self-check (DOM ids / module imports / static assets / exercise catalogue and category lists)
npm run test:app               # integration test that loads the real app.js with a minimal DOM stub
```

| Test file | Cases | Coverage |
|---|---|---|
| `tests/test-i18n.mjs` | 18 | Identical key structure across Chinese and English, no untranslated strings, matching placeholders and array lengths, no hard-coded Chinese left in the source, and a consistent structure across both READMEs |
| `tests/test-detectors.mjs` | 247 | Rep counting, hold timing, form-step scoring and scoring order for correct reps and every kind of incorrect rep, depth judging under an angled camera, plus the pre-workout calibration checks |
| `tests/test-engines.mjs` | 141 | The generic engines: one rep per cycle, lenient vs strict, the boundaries for wobbles and speeding, posture gating, feet off the floor when jumping, left/right alternation, whole sequences, and pausing/resuming the timer |
| `tests/test-specs.mjs` | 377 | Feeds the numbers shown in the modal back into the detectors: they must land exactly on the detector's own counting lines; posture-gate numbers come from the same table used for judging; all 22 exercises have thresholds; both languages are complete |
| `tests/test-page.mjs` | 310 | DOM wiring, module imports and exports, static assets, the category lists of all 22 exercises and the completeness of their scoring plans |
| `tests/test-app.mjs` | 254 | Startup with the real `app.js`, home-page rendering, both the exercise-settings (counting thresholds included) and settings modals, the calibration flow, exercise switching, scoring, sound, the set summary and Chinese/English switching |

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
│  ├─ catalog.js         ★ the exercise library: five categories + 22 exercises (icon, type, engine, thresholds, judging basis)
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
├─ tests/                the five automated test suites
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
    `enterHoldMs` / `exitHoldMs` are the jitter tolerances; `PUSHUP.elbowFull` 106 / `PUSHUP.looseElbow` 124;
    `BRIDGE.upRise` 0.22 and `minRepMs` 700; `PLANK.bodyStraight` 142;
  - `HoldDetector.graceMs`: the grace period for timed exercises (default 1200ms).
  - **Relaxed vs strict**: `DetectorBase.strict` defaults to `false` (roughly doing the movement counts; poor form only triggers a spoken correction plus a quality discount);
    the **✅ Strict mode** switch in the settings modal changes the criteria to “only a full-depth rep counts”.

After changing anything, run `npm test` — the tests have the standard range of motion for these exercises baked in, so they'll tell you right away if you've tightened things too far.

**How the tracking works**: every criterion uses only **angles** and **ratios divided by torso length**, so it's independent of your height and how far away the camera is;
landmarks are first corrected for the frame's aspect ratio before angles are computed, and a One Euro filter suppresses jitter — so one set of thresholds fits different people and different camera positions.

---

## Privacy and license

- Video is processed only in your local browser, and **nothing is uploaded**; the model and wasm are local files, so it works offline.
- The server listens only on `127.0.0.1` by default, so no one else on your network can reach it.
- Workout history lives only in your own browser's localStorage.
- Third-party resources: MediaPipe Tasks Vision (wasm) and the Pose Landmarker model under `vendor/` come from Google MediaPipe and are licensed under the **Apache License 2.0**.
