# Motion Fitness Game

[中文](README.md) · [English](README.en.md) · [Español](README.es.md) · [Français](README.fr.md)

A small fitness game that uses an ordinary webcam for motion tracking: **automatic rep counting for Squat / Lunge / Push-up / Glute Bridge**, **automatic timing for Plank / Static Glute Bridge**,
and **step-by-step scoring against your form** — every form step you hit instantly earns points, rings a chime, and is spoken aloud.

The interface ships in **中文 / English / Español / Français**, switchable any time from the top-right corner of the page.

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
- [How to use it (camera angle matters)](#how-to-use-it-camera-angle-matters)
- [Scoring rules](#scoring-rules)
- [Languages](#languages)
- [Standing there with no response? Three checks](#standing-there-with-no-response-three-checks)
- [FAQ](#faq)
- [Tests](#tests)
- [Project structure](#project-structure)
- [Tuning scores and thresholds yourself](#tuning-scores-and-thresholds-yourself)
- [Privacy and license](#privacy-and-license)

---

## Feature highlights

- **Form steps scored one at a time**: each exercise is broken into 4–6 judgeable steps — hit one and you immediately get points, a chime, and a checkmark;
  finishing every step in a round earns a perfect-round bonus, and hold exercises give **+1 point for every second you hold**.
- **Valid rep detection**: half reps, reps that are too fast, a sagging lower back, a piked hip and so on don't count as valid reps — they're tracked separately and you get a correction cue.
- **Live status feedback**: the area below the video always shows what state you're in, which step you're stuck on, and how many degrees you still need.
- **🐞 Metrics panel**: one click shows every raw number the detector sees (view, visibility, each joint angle), so camera-position problems are obvious at a glance.
- **Spoken counting in your language + sound effects**: hitting a form step plays a rising chime, the first time you hit a step it's spoken aloud, and your score is announced every 50 points.
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

If you don't have Homebrew yet, first run the command from the official site in **Terminal** (<https://brew.sh>):

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
3. Open **Terminal** to verify

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

The first time in, click “Start camera” → choose “Allow” in the browser prompt → pick an exercise → **stand sideways to the camera and you start scoring right away**.

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

## How to use it (camera angle matters)

**All six exercises work best with you sideways to the camera** (body perpendicular to the lens) — that's the only way the joint angles are real angles:

- Stand **2–3 m (6–10 ft)** away from the camera with your **whole body in frame** (head to feet);
- **Squat / Lunge**: stand sideways to the camera so your ankles, knees, hips and shoulders are all visible at once;
- **Push-up / Plank**: lie or face perpendicular to the lens with both hands and both feet inside the frame;
- **Glute Bridge / Static Glute Bridge**: camera at your side, so your shoulders, hips, knees and ankles are all visible at once;
- Even lighting, a clean background, and closer-fitting clothes all make tracking more stable.

**Note: tracking starts the moment you pick an exercise — you don't have to click “Start set” first.**
Stand sideways to the camera and the “stance” step's points and chime appear immediately. Clicking “Start set” only starts the timer and records a set.

**Shortcuts**: `1`–`6` switch exercise · `Space` start/pause · `R` reset reps · `Esc` end set · `M` mirror · `S` skeleton · `F` fullscreen

---

## Scoring rules

The right side of the interface has a **form-step checklist**: hit a step and it's immediately checked off, scored, and chimed, and the step you should be doing next is highlighted.
Completing **every form step in the round** earns an extra perfect-round bonus, and hold exercises add **+1 point for every second you hold it**.

### Squat (45 points per round)

| Form step | How it's judged | Points |
|---|---|---|
| ① Stand sideways to the camera, full body in frame and upright | Side view + full body visible + body close to vertical + knee angle >150° | +4 |
| ② Push your hips back and down (start from the hips) | Knee angle ≤152° and the hip angle opens up | +6 |
| ③ Bend both knees, tracking over your toes | Knee angle ≤135° | +7 |
| ④ **Squat until your thighs are near horizontal (top-scoring step)** | Thigh ≤25° from the floor (or hips below knees) | **+14** |
| ⑤ Drive up to standing, full hip and knee extension | Knee angle ≥150° and the hip angle back to ≥130° | +8 |
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

### Push-up (40 points per round)

| Form step | How it's judged | Points |
|---|---|---|
| ① Hands on the floor, body in one straight line | Push-up position + body line angle ≥165° + no sagging, no piking | +5 |
| ② Brace your core and bend your elbows to lower down | Elbow angle ≤140° | +7 |
| ③ **Elbows to 90° or less, chest close to the floor (top-scoring step)** | Elbow angle ≤95° and the body still in one straight line | **+14** |
| ④ Press back up to fully straight arms | Elbow angle ≥145° (after first lowering down) | +8 |
| 🎁 All form steps complete for the round | All 4 steps above hit within the same round | +6 |

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
| ② Head, back, hips and ankles in one straight line | Body line angle ≥158° + no sagging, no piking | +12 |
| ③ Hold steady for 3 seconds | Held for a full 3 seconds | +10 |
| ④ Hold steady for 10 seconds | Held for a full 10 seconds | +15 |
| ⑤ Hold steady for 30 seconds | Held for a full 30 seconds | +25 |
| ⏱ For every second you hold | While your form is valid | +1/sec |

### Static Glute Bridge (63 points per set, plus 1 point per second)

| Form step | How it's judged | Points |
|---|---|---|
| ① Lie on your back with knees bent, feet planted hip-width apart | Supine bent-knee position | +6 |
| ② Lift your hips to the top position | Hip lift > 0.32× torso length | +12 |
| ③ Squeeze your glutes and hold 3 seconds | Held for a full 3 seconds | +10 |
| ④ Hold 10 seconds | Held for a full 10 seconds | +15 |
| ⑤ Hold 20 seconds | Held for a full 20 seconds | +20 |
| ⏱ For every second you hold | While your form is valid | +1/sec |

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

Both sound effects and voice can be turned off with one click in the top bar.

---

## Languages

Four languages are built into the interface. Switch any time with the **Language** dropdown in the top-right corner — your choice is remembered:

| Language | Code | Locale file |
|---|---|---|
| 中文 | `zh` | `src/locales/zh.js` |
| English | `en` | `src/locales/en.js` |
| Español | `es` | `src/locales/es.js` |
| Français | `fr` | `src/locales/fr.js` |

The first time you open it, the language is picked from your browser language (Chinese / English / Spanish / French; anything else falls back to English).

**Adding a language**: copy `src/locales/en.js` and translate it, import it in `src/i18n.js` and add it to `LOCALES`,
then run `npm run test:i18n` again — the test checks every entry for missing keys, untranslated strings, placeholders and array lengths, so nothing slips through.

---

## Standing there with no response? Three checks

**① Check the version first.** The page title should show `v1.3` next to it. If you don't see it, the browser is still running a cached old version — force a refresh with **Ctrl + F5** (**Cmd + Shift + R** on Mac).

**② Look at the status bar below the video.** It always tells you where you're stuck:

| Status bar text | Meaning |
|---|---|
| No person detected: step into the middle of the frame… | The model can't find a person → see “FAQ” below |
| Next up, “Stand sideways to the camera…”: you look like you're facing the camera | It found you, but the camera angle is wrong |
| Next up, “…”: can't see your whole body | It found you, but some body parts are out of frame |
| Got you ✓ hold that spot and start moving | All good — just do the exercise |
| Start the camera first / Loading model… | The pipeline isn't up yet |

**③ Turn on “🐞 Metrics” in the top-right corner.** The numbers the detector sees are listed live below the video, for example:

```
View Side ✓(0.18) · Full body ✓ · Both legs visible ✓ · Trunk lean 6° · Knee 176° · Elbow 172° ·
Hip 172° · Body line 175° · Hip lift -0.98 · Thigh from horizontal 88° · Visibility 0.94 · State running
```

Read them like this:

| Symptom | Cause | Fix |
|---|---|---|
| `View Front ✗(0.90)` | You're actually facing the camera or turned toward it | Turn sideways to the camera |
| `Full body ✗` | Some body parts are out of frame | Back up 1–2 steps so you're in frame from head to feet |
| `No person detected` | Too far / too close, backlighting, or a background the same color as your clothes | Move closer, face the light source, change clothes, or use a higher-resolution camera |
| `Trunk lean` stuck above 32° | The camera is tilted or you're standing crooked | Straighten the camera (or level it with a book) |
| The numbers look fine but nothing gets checked off | You're stuck right on a step's threshold | The status bar spells out exactly how far off you are (for example, “your thighs are still about 12° from horizontal”) |

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
Switch **Model** in the top bar to **Lite**; turn off **📐 Angles**; try a faster device. Tracking still works fine at 10–15 FPS.

**Q: Does it work on a phone?**
Yes. Open the same address in your phone's browser (the phone and the computer need to be on the same local network, and the server has to listen on `0.0.0.0`:
change `'127.0.0.1'` to `'0.0.0.0'` in `preview-server.js` and restart). Note that this also lets anyone else on the same network reach it.

**Q: Where is the data stored?**
Workout history and best scores live in the browser's localStorage, so they're lost if you switch browsers or clear your cache — and they're never uploaded to any server.

---

## Tests

```bash
npm test                       # run all four suites (285 cases)
npm run test:i18n              # i18n: missing keys / untranslated strings / placeholders / array lengths / leftover Chinese in source
npm run test:detectors         # detection and scoring logic (driven by synthetic skeletons)
npm run test:dump              # also prints baseline posture metrics, handy for tuning thresholds
npm run test:page              # page wiring self-check (DOM ids / module imports / static assets)
npm run test:app               # integration test that loads the real app.js with a minimal DOM stub
```

| Test file | Cases | Coverage |
|---|---|---|
| `tests/test-i18n.mjs` | 32 | Identical key structure across all four languages, no untranslated strings, matching placeholders and array lengths, no hard-coded Chinese left in the source |
| `tests/test-detectors.mjs` | 91 | Rep counting, hold timing, form-step scoring and scoring order for correct reps and every kind of incorrect rep |
| `tests/test-page.mjs` | 89 | DOM wiring, module imports and exports, static assets, completeness of the scoring plans |
| `tests/test-app.mjs` | 73 | Startup, exercise switching, scoring, sound, the set summary, the skeleton toggle and language switching with the real `app.js` |

---

## Project structure

```
motion-fitness-game/
├─ index.html            page structure (all copy goes through data-i18n)
├─ style.css             dark UI styling
├─ preview-server.js     zero-dependency local server (http://127.0.0.1:4174)
├─ src/
│  ├─ i18n.js            ★ i18n core (t / setLang / applyI18n)
│  ├─ locales/           ★ the four locale files: zh.js / en.js / es.js / fr.js
│  ├─ geometry.js        geometry and signal processing (angles, One Euro smoothing)
│  ├─ metrics.js         per-frame exercise metrics (joint angles, hip lift, body straightness…)
│  ├─ steps.js           ★ the scored form steps per exercise (condition + points + hint key)
│  ├─ exercises.js       ★ detection state machines + scoring engine for the six exercises
│  ├─ pose-engine.js     MediaPipe PoseLandmarker wrapper + camera management
│  ├─ render.js          skeleton rendering
│  ├─ audio.js           sound effects + speech (follows the selected language)
│  └─ app.js             UI, workout flow, form-step checklist, records, main loop
├─ tests/                the four automated test suites
└─ vendor/               MediaPipe tasks-vision (wasm) and the pose model (offline)
```

---

## Tuning scores and thresholds yourself

- **Change point values or form-step wording**: edit `src/steps.js` (structure and points) and `src/locales/*.js` (wording).
  Each step is one `{ id, labelKey, points, check, hint }`; when `check(frame, det)` returns `true`, that step counts as hit.
- **Change the judging thresholds**: edit the constants at the top of each exercise in `src/exercises.js` — they all have Chinese comments:
  - `SQUAT.thighParallel`: how many degrees from horizontal counts as “deep enough” (default 25°, lower is stricter);
  - `LUNGE.backKneeDrop`: back-knee height off the floor / shin length (default 0.35, lower is stricter);
  - `PUSHUP.elbowFull`: elbow angle at the bottom of a push-up (default 92°);
  - `BRIDGE.upRise` / `BRIDGE_HOLD.holdRise`: glute bridge hip-lift height (in units of torso length);
  - `PLANK.bodyStraight`: the minimum angle for “body in one straight line” in a plank (default 158°);
  - `HoldDetector.graceMs`: the grace period for timed exercises (default 1200ms).

After changing anything, run `npm test` — the tests have the standard range of motion for these exercises baked in, so they'll tell you right away if you've tightened things too far.

**How the tracking works**: every criterion uses only **angles** and **ratios divided by torso length**, so it's independent of your height and how far away the camera is;
landmarks are first corrected for the frame's aspect ratio before angles are computed, and a One Euro filter suppresses jitter — so one set of thresholds fits different people and different camera positions.

---

## Privacy and license

- Video is processed only in your local browser, and **nothing is uploaded**; the model and wasm are local files, so it works offline.
- The server listens only on `127.0.0.1` by default, so no one else on your network can reach it.
- Workout history lives only in your own browser's localStorage.
- Third-party resources: MediaPipe Tasks Vision (wasm) and the Pose Landmarker model under `vendor/` come from Google MediaPipe and are licensed under the **Apache License 2.0**.
