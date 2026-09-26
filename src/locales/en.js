/**
 * English (en-US) locale.
 * Keep the key structure **exactly identical** to zh.js — missing keys fall back to English.
 */

export default {
  meta: {
    code: 'en',
    label: 'English',
    flag: '🇬🇧',
    htmlLang: 'en',
    speechLang: 'en-US',
    title: 'Motion Fitness · Rep Counting & Hold Timer',
  },

  app: {
    brand: 'Motion Fitness',
    subtitle: '60+ camera-tracked exercises · Upper body / Lower body / Core / Full body / Stretching · Rep counting and holds · Scored step by step on your form',
  },

  /* ---------------- Interface ---------------- */
  ui: {
    kindRep: "Count",
    kindHold: "Timer",
    // Timed counting (Jumping Jack: a fixed 60 seconds, see how many you can do)
    kindTimed: "Timed reps",
    // Remaining time on the HUD: “⏱ 42 / 60 sec left”
    timeLeft: '{left} / {total} sec left',
    shortcutsText: "<kbd>1</kbd>–<kbd>9</kbd> Quick switch · <kbd>H</kbd> Home · <kbd>G</kbd> Settings · <kbd>Space</kbd> Start/Pause · <kbd>R</kbd> Reset · <kbd>Esc</kbd> End set · <kbd>M</kbd> Mirror · <kbd>S</kbd> Skeleton · <kbd>F</kbd> Fullscreen",
    language: 'Language',
    model: 'Model',
    modelLite: 'Lite (smoother)',
    modelFull: 'Full (more accurate)',
    mirror: '🪞 Mirror',
    voice: '🔊 Voice count',
    sfx: '🎵 Sound FX',
    music: '🎶 Music',
    skeleton: '🦴 Skeleton',
    angles: '📐 Angles',
    debug: '🐞 Metrics',
    fullscreen: 'Fullscreen video frame',

    startCam: 'Start camera',
    retry: 'Retry',
    camera: 'Camera',
    lens: 'Lens',
    resetReps: 'Reset reps',

    step1: '① Pick an exercise',
    step2: '② Set your goal',
    step3: '③ Start training',
    actionGuide: 'Form steps',
    scoreCard: 'Form score',
    best: 'Best',
    history: 'Workout history',
    clear: 'Clear',
    shortcuts: 'Shortcuts',

    start: 'Start set',
    pause: 'Pause',
    resume: 'Resume',
    stop: 'End set',
    training: 'Training…',

    totalScore: 'Total score',
    validReps: 'Valid reps',
    partial: 'Partial / not counted',
    setTime: 'Set time',
    holdTime: 'Hold time',
    depth: 'Range of motion',
    targetPrefix: 'Goal',
    repsUnit: 'reps',
    secondsUnit: 'sec',

    summaryTitle: 'Set summary',
    colAction: 'Exercise',
    colScore: 'Score',
    colValidReps: 'Valid reps',
    colHold: 'Valid hold',
    colCompletion: 'Completion',
    colSteps: 'Form steps',
    colElapsed: 'Time',
    stepsDoneRatio: '{done}/{total} steps',

    noRecords: 'No records yet — go knock out a set.',
    noHistory: 'No workouts yet.',
    clearConfirm: 'Clear all workout history and best scores?',

    stepsNote: 'Work through the form steps one at a time: hit a step and you instantly get points, a chime, and a checkmark. Complete every step in the round and you get a full-marks bonus.',
    gestureExit: 'Exit',
    gestureRetry: 'One more set',
    gestureHint: 'Hold your palm in the middle of a circle for 3 seconds: left = exit, right = one more set (tapping works too)',
    gestureVoice: 'Hold your palm inside a circle for three seconds to go back home, or to do one more set.',
    criteriaPtsMax: 'Up to +{n} points on this keyframe',
    criteriaPtsPerSec: 'Plus +{n} point per second while you hold',
    criteriaPtsGot: 'Already earned +{n} points here',
    nextStep: 'Next',
    stepsAllDone: 'All form steps complete for this round ✓',
    nextStepWithHint: 'Next up, “{label}”: {hint}',
    nextStepNoHint: 'Next up, “{label}”',

    maskTitle: 'Start the camera to train',
    maskText: 'Everything runs right here in your browser. No video ever leaves your device.',
    maskHint: 'Tip: use a webcam or hold your phone in landscape, stand 6–10 ft (2–3 m) from the camera; face the camera for squats and turn sideways for every other exercise.',
    maskOpening: 'Opening the camera…',
    maskOpeningText: 'Choose “Allow” in the browser prompt. If nothing happens, tap the button below to retry.',
    maskCamFailTitle: 'Couldn’t open the camera',
    maskCamFailSuffix: '. Check your browser permission settings, and make sure no other app is using the camera.',
    maskModelLoading: 'Loading the pose model…',
    maskModelText: 'The first load takes a few seconds (the model is a local file — no internet needed).',
    maskModelFail: 'Couldn’t load the pose model',
    maskUnsupportedTitle: 'This browser doesn’t support the camera',
    maskUnsupportedText: 'Please use the latest Chrome / Edge / Safari and open this page over http(s).',
    unknownError: 'Unknown error',
  },

  /* ---------------- Pre-workout calibration ---------------- */
  calib: {
    title: 'Pre-workout calibration',
    lead: 'Move into the dashed body outline so your whole body is in frame',
    waiting: 'Waiting for calibration…',
    needCalib: 'Move into the dashed outline and finish calibration first, then tap “Start set”',
    doneVoice: 'All rested? Tap Start set for the next set',
    startNow: 'Rested? Tap “Start set” for the next set (or press Space)',
    recalibrate: 'Recalibrate',
    ready: 'Great position — hold it…',
    adjust: 'Move into the dashed body outline',
    promptIn: 'Move into the dashed outline — head to toe',
    promptSearch: 'Can’t find you: adjust your position so your whole body sits inside the dashed outline',
    promptReady: 'Great position — hold still…',
    visible: 'Can’t see your whole body clearly: adjust your position so you’re in frame from head to toe',
    headCut: 'Your head is out of frame: back up a little',
    feetCut: 'Your feet are out of frame: back up a little',
    cutOff: 'One side of your body is out of frame: step back a little, or shift inwards (no need to stand dead centre)',
    lieCutOff: 'One end of your body is out of frame: back up a little, or shift inwards (no need to be dead centre)',
    tooFar: 'You’re too far from the camera: move a little toward the camera to line up with the dashed outline',
    tooClose: 'You’re too close to the camera: move a little away from the camera to line up with the dashed outline',
    centerLeft: 'Shift a little to the left to land in the middle of the outline',
    centerRight: 'Shift a little to the right to land in the middle of the outline',
    moveUp: 'Move a little higher in the frame (you’re too low right now)',
    moveDown: 'Move a little lower in the frame (you’re too high right now)',
    viewFront: 'Face the camera: squats need a front-on view to measure depth accurately',
    viewSide: 'Turn sideways to the camera: this move needs a side view to measure angles accurately',
    steady: 'Nice — hold still…',
    check: {
      visible: 'Body detected',
      framing: 'Full body in frame',
      distance: 'Good distance',
      center: 'Centered',
      vertical: 'Good height',
      view: 'Camera angle right',
      steady: 'Holding still',
    },
  },

  /* ---------------- Status bar / notices ---------------- */
  status: {
    noPerson: 'No person detected — step into the middle of the frame and keep your whole body in view (back up 1–2 steps)',
    noDetector: 'Detector not ready: retap the action button',
    noSound: 'No sound: ① check the tab isn’t muted (speaker icon) ② volume isn’t 0 ③ a voice pack is installed',
    ready: 'Got you ✓ hold that spot and start moving',
    needCamera: 'Start the camera first',
    countdownGo: 'Go! Follow the cues — partial reps don’t count.',
    paused: 'Paused. Tap “Resume” to keep going.',
    resume: 'Keep going!',
    setDone: 'Set complete. Take a breather, or start a new one.',
    reset: 'Reps and score reset.',
    skeletonOn: 'Skeleton overlay on.',
    skeletonOff: 'Skeleton overlay hidden — camera view only.',
    musicOn: 'Cheerful background music on.',
    musicOff: 'Background music off.',
    musicTrack: 'Background music switched to “{name}”',
    modelReady: 'Model ready. Pick an exercise, move into the dashed outline to finish calibration, then start your set.',
    modelSwitched: 'Switched to the “{model}” model.',
    modelSwitchFail: 'Model switch failed: {msg}',
    fileProtocol: 'Opened over file:// — the browser will block the model and the camera. Run node preview-server.js and open http://127.0.0.1 instead.',
    half: 'Halfway there — keep it up!',
    halfVoice: 'Halfway there — awesome, keep it up',
    milestone: '{score} points already!',
    goalVoice: 'Goal reached, awesome',
    // Timed counting: announce the duration up front, then call the time at the end
    timedGo: '⏱ {sec} seconds on the clock — see how many you can do!',
    timeUpVoice: 'Time is up, awesome',
    cameraReady: 'Camera {w}×{h}',
    cameraOff: 'Camera off',
    modelLoading: 'Loading model…',
    modelReadyShort: 'Model ready {model}/{delegate}',
    searching: 'Looking for you… (step into the frame)',
    personFound: 'Person detected ✓',
    notSupine: 'Glute bridges are done lying down — lie on your back and bend your knees',
    holdPaused: 'The timer restarts automatically once your form is back',
    standbyPushup: 'Get down into a push-up first: hands under your shoulders, body in one straight line, sideways to the camera',
    standbyBridge: 'Lie on your back on the mat: knees bent, feet planted, sideways to the camera',
    standbyPlank: 'Get down on your forearms or hands and keep your body flat',
    standbyBridgeHold: 'Lie on your back with knees bent and feet planted, sideways to the camera',
    lostTracking: 'Can’t see your whole body — back up a little and keep yourself fully in frame',
    camOff: 'Camera off (it turns back on when you open an exercise)',
    need: {
      stand: 'Step into the frame and set up your stance',
      prone: 'Get down and set up: hands under your shoulders, body in one line',
      supine: 'Lie down on the mat: on your back with knees bent, set up for the move',
      // Lying leg raise: the start is simply lying flat with straight legs (the "knees bent" line is the bridge/crunch pose)
      supineStraight: 'Lie flat on the mat: body flat, legs straight and relaxed (hip and knee both flat, about 180°)',
      // Crunch: the starting pose is "lie down with knees bent" (different from the bridge / leg raise start)
      crunchLying: 'Lie on the mat with your knees bent: trunk flat (tilt about 90°), knees bent to about 90°, feet planted',
      quadruped: 'Get on all fours: hands and knees on the floor',
      kneel: 'Kneel down: knees on the floor, torso tall',
      seated: 'Sit down on the mat and set up for the move',
      side: 'Lie on your side toward the camera, resting on your forearm',
      inverted: 'Handstand against the wall: body vertical, hips above your shoulders',
      hang: 'Hang from the bar with both hands, feet off the floor',
    },
    camOff: 'Camera off (it turns back on when you open an exercise)',
  },

  /* ---------------- Phase names ---------------- */
  phase: {
    idle: 'Ready',
    up: 'Up',
    down: 'Down',
    descending: 'Lowering',
    bottom: 'Bottom',
    holding: 'Holding',
    paused: 'Paused',
  },

  /* ---------------- Set summary ---------------- */
  summary: {
    goalReached: '🎉 Goal reached — set saved! Set score: {score} points.',
    savedWithMiss: 'Set score: {score} points. Next time watch: {list}',
    savedAll: 'Set score: {score} points — every form step complete!',
    noData: 'This set didn’t produce any valid data. Give it another go.',
    celebrate: '🎉 Goal reached: {value}',
    celebrateReps: '{n} reps',
    celebrateHold: '{n} seconds',
    // Timed counting: running out of time *is* reaching the goal
    celebrateTimed: '⏱ {n} seconds up!',
    timedDone: '⏱ {sec} seconds up: {n} reps done · {score} points this set.',
  },

  /* ---------------- Diagnostics panel ---------------- */
  debug: {
    noPerson: 'Metrics: no person detected',
    view: 'View',
    // The app appends ✓/✗ itself — whether a view is “correct” depends on the exercise
    // (squats need a front-on view, everything else needs a side view).
    viewSide: 'Side',
    viewFront: 'Front',
    bodyVisible: 'Full body',
    legsVisible: 'Both legs visible',
    trunkLean: 'Trunk lean',
    // Short name for the on-screen angle label (same length as “Hip / Knee”, so the pills never overlap)
    trunk: 'Trunk',
    knee: 'Knee',
    // The on-screen readout for the jumping jack (its criterion is a spread, not an angle)
    legSpread: 'Spread',
    // With both legs in frame the two knees are labelled separately (the user asked for it)
    kneeL: 'Left knee',
    kneeR: 'Right knee',
    elbow: 'Elbow',
    hip: 'Hip',
    bodyStraight: 'Body line',
    // Shoulder joint angle (hip-shoulder-elbow): the plank uses it to judge "are the arms propping you up"
    shoulderJoint: 'Shoulder',
    hipRise: 'Hip lift',
    // The standing gate (butt kick) judges the positive form “shoulders above hips”: about +1.0 standing,
    // and it is the exact negative of “Hip lift” right above
    shoulderAboveHip: 'Shoulders above hips',
    // Floor-relative values used by the standing gate (they differ a lot between standing and lying)
    kneeClear: 'Knee off floor',
    hipClear: 'Hip off floor',
    thighFromHoriz: 'Thigh from horizontal',
    visibility: 'Visibility',
    // Short name for the on-screen "head off the floor" readout (a key crunch metric)
    head: 'Head',
    // The 🐞 panel line showing the quantity this exercise is actually judged by
    progress: 'progress',
    sound: 'Sound',
    state: 'State',
    // Whether the dashed body outline was drawn this frame (✗ once you are recognised)
    outline: 'Outline',
    // The bottom-left “Exit” ring line: where the hand/foot is and how far it is from the ring centre
    touch: 'Hand/foot',
    noTouch: 'no hand or foot seen',
    hand: 'hand',
    foot: 'foot',
    ringDist: 'from ring centre',
    inRing: 'inside',
    nearRing: 'nearly there',
    outRing: 'outside',
    // Which part entered the ring ("any part counts": fingertip / heel / toe tip / ankle / wrist)
    inPoints: 'points inside',
    part: {
      wrist: 'wrist',
      index: 'finger',
      pinky: 'pinky',
      thumb: 'thumb',
      ankle: 'ankle',
      heel: 'heel',
      toe: 'toe',
    },
    yes: '✓',
    no: '✗',
    count: 'Rep diagnosis',
    diag: {
      stage: 'Stage',
      steps: 'Steps',
      counts: 'Valid/partial',
      backLine: 'Return line',
      countLine: 'Counting line',
      repMin: 'This rep min',
      topBase: 'Tracked top',
      drop: 'Shoulder drop',
      standLine: 'Standing line',
      startSeen: 'Starting pose',
      bothMin: 'Both knees (back/line)',
      ridgeRise: 'Hip lift (top/floor line)',
      bridgeAngle: 'Hip angle (angle-path line)',
      floorLine: 'Baseline lowest point',
      startValue: 'Start (yours/ref)',
      peak: 'This rep peak',
      hold: 'Held',
      pose: 'Posture',
      // Alternating exercises (butt kick / mountain climber / dead bug): both legs, the alternation lines, last side
      sides: 'Both sides',
      line: 'Line (enter/exit)',
      otherHold: 'Other-leg rule',
      // Crunch: trunk tilt (now / lying baseline), shoulder-hip ratio (now / line), head height (now / line)
      torsoTilt: 'Trunk tilt (now/base)',
      torsoShrink: 'Shoulder-hip (now/line)',
      headClear: 'Head off floor (now/line)',
      side: 'Current side',
      lastSide: 'Last side/gap',
      reject: 'Last not counted',
    },
  },

  /* ---------------- Exercise metadata ---------------- */
  ex: {
    squat: {
      name: 'Bodyweight Squat',
      cameraHint: 'Face the camera with your whole body in frame (squats need a front-on view to measure depth accurately)',
      goal: 'Squat until your thighs are parallel to the floor or lower',
      howto: ['Stand with your feet shoulder-width apart, facing the camera', 'Bend your knees and sink down, sending your hips downward with your knees tracking over your toes', 'Squat until your thighs are parallel to the floor or lower', 'Drive through your feet to stand tall — full hip and knee extension counts as one rep'],
      tips: ['Keep the whole foot planted — heels stay down', 'Don’t let your knees cave inward', 'Don’t arch your lower back on the way up'],
    },
    lunge: {
      name: 'Forward Lunge',
      cameraHint: 'Turn sideways to the camera with your feet split front and back',
      goal: 'Both knees near 90°, back knee close to the floor',
      howto: ['Step one leg far forward', 'Bend both knees and sink down, front knee around 90°', 'Lower your back knee until it’s close to the floor', 'Drive through your front foot back to standing, alternating legs'],
      tips: ['Don’t let your front knee drift far past your toes', 'Keep your torso upright', 'Alternate legs on every rep'],
    },
    pushup: {
      name: 'Push-up',
      cameraHint: 'Turn sideways to the camera, on the floor or a mat',
      goal: 'Bend your elbows to 90° or less, chest close to the floor',
      howto: ['Hands slightly wider than your shoulders, body in one straight line', 'Brace your core and bend your elbows to lower down', 'Elbows to 90° or less with your chest close to the floor', 'Press back up — fully straight arms count as one rep'],
      tips: ['Keep your body in one straight line the whole time', 'Don’t let your hips sag or pike up', 'Keep your wrists directly under your shoulders'],
    },
    bridge: {
      name: 'Glute Bridge',
      cameraHint: 'Turn sideways to the camera, lying on your back with knees bent and feet planted',
      goal: 'Lift your hips until shoulders, hips and knees form a straight line',
      howto: ['Lie on your back with knees bent, feet hip-width apart and planted', 'Squeeze your glutes and drive your hips up', 'Lift until shoulders, hips and knees are almost in a straight line', 'Lower your hips back to the floor under control — that counts as one rep'],
      tips: ['Drive with your glutes, not your lower back', 'Pause 1 second at the top and feel the squeeze', 'Tuck your chin slightly and keep your shoulder blades on the floor'],
    },
    plank: {
      name: 'Plank',
      cameraHint: 'Turn sideways to the camera, on your forearms or hands',
      goal: 'Hold your body in one straight line',
      howto: ['Plant your forearms directly under your shoulders (or use straight arms)', 'Brace your core — head, back, hips and ankles in one line', 'Breathe steadily and keep holding', 'If your form breaks, the timer pauses automatically'],
      tips: ['Don’t let your hips rise or drop', 'Push your shoulder blades away from the floor', 'Stop when you can’t hold it — don’t push through back pain'],
    },
    squatSumo: {
      name: 'Sumo Squat',
      cameraHint: 'Face the camera with your feet about 1.5 shoulder-widths apart and your toes turned out',
      goal: 'Knees out wide, sink down until your thighs are near horizontal',
    },
    lungeBack: {
      name: 'Reverse Lunge',
      cameraHint: 'Stand side-on to the camera with your feet split front and back',
      goal: 'Step one leg far back and bend both knees to sink down',
    },
    squatJump: {
      name: 'Jump Squat',
      cameraHint: 'Face the camera and leave room above you',
      goal: 'Squat all the way down, then jump hard so both feet leave the floor',
    },
    buttKick: {
      name: 'Butt Kick',
      cameraHint: 'Stand side-on to the camera and leave room front and back',
      goal: 'Bounce lightly in place, kicking your heels up towards your glutes one leg at a time — 60 seconds timed, see how many you can do',
    },
    crunch: {
      name: 'Crunch',
      cameraHint: 'Turn sideways to the camera, lying on your back with knees bent and feet planted',
      goal: 'Curl your shoulder blades off the floor with your abs, then lower slowly',
    },
    reverseCrunch: {
      name: 'Reverse Crunch',
      cameraHint: 'Turn sideways to the camera, lying on your back with knees bent',
      goal: 'Curl your knees toward your chest with your lower abs and lift your hips slightly',
    },
    lyingLegRaise: {
      name: 'Lying Leg Raise',
      cameraHint: 'Turn sideways to the camera, lying on your back with your legs straight',
      goal: 'Raise both legs together to near vertical, then lower them under control',
    },
    mountainClimber: {
      name: 'Mountain Climber',
      cameraHint: 'Turn sideways to the camera, up on straight arms',
      goal: 'Drive your knees toward your chest one after the other, fast',
    },
    jumpingJack: {
      name: 'Jumping Jack',
      cameraHint: 'Face the camera with your whole body in frame (the leg spread is what gets measured)',
      goal: 'Jump your feet wide and back together while your arms go up and down — 60 seconds timed, see how many you can do',
      howto: ['Face the camera with your feet together and your arms at your sides', 'Jump your feet out to about one and a half shoulder-widths while your arms go overhead', 'Jump back to feet together with your arms at your sides — that is one rep'],
      tips: ['Land softly on the balls of your feet instead of slamming your heels', 'Do not shrug your shoulders when your arms go overhead, keep breathing', 'Knees track over your toes, never caving in'],
    },
    deadBug: {
      name: 'Dead Bug',
      cameraHint: 'Turn sideways to the camera, lying on your back with knees bent and arms up',
      goal: 'Tabletop position: one leg extends at a time with the opposite arm reaching overhead, lower back stays down, alternating sides',
      howto: [
        'Lie on your back in the tabletop position: thighs vertical, shins parallel to the floor, arms straight up, lower back pressed down',
        'Brace your abs and slowly reach one leg out toward the floor — the knee straightens and the thigh opens away from your body',
        'At the same time lower the opposite arm overhead, while the other leg stays bent in the tabletop position',
        'Bring it back and extend the other leg — alternating sides (each switch counts one rep)',
      ],
      tips: ['Keep your lower back pressed to the floor — no arching', 'One leg at a time: the other leg must not move', 'Slower is harder — stay controlled and even'],
    },
    burpee: {
      name: 'Burpee',
      cameraHint: 'Face the camera and leave room in front of you and above you',
      goal: 'Squat and plant your hands → jump back to a plank → pull your legs in and stand → jump up',
    },
    boxJump: {
      name: 'Box Jump',
      cameraHint: 'Face the camera with a steady box in front of you',
      goal: 'Bend your knees, swing your arms and jump onto the box, stand tall, then step down',
    },
    standingForwardFold: {
      name: 'Standing Forward Fold',
      cameraHint: 'Stand side-on to the camera with your feet together or hip-width apart',
      goal: 'Knees slightly bent, hinge forward and fold down from your hips',
    },
    seatedForwardFold: {
      name: 'Seated Forward Fold',
      cameraHint: 'Turn sideways to the camera, seated with both legs straight',
      goal: 'Hinge forward from your hips and reach your hands toward your toes',
    },
  },

  /* ---------------- Form steps ---------------- */
  steps: {
    squat: {
      stance: {
        label: 'Stand facing the camera with your whole body in frame and your body upright',
        view: 'You look like you’re sideways to the camera: face the camera instead (squats need a front-on view to measure depth accurately)',
        body: 'Can’t see your whole body: back up a little so you’re in frame from head to feet',
        lean: 'You’re tilting to one side: stand up straighter and stay symmetrical left to right',
        knee: 'Straighten both legs all the way',
        tune: 'Square up a little more to earn this step',
      },
      hinge: { label: 'Bend your knees and sink down, hips going downward', hint: 'Start the squat: bend your knees and send your hips downward' },
      descend: { label: 'Bend both knees, tracking over your toes', hint: 'Keep sinking down and bend your knees a bit more' },
      parallel: { label: 'Squat until your thighs are near horizontal (top-scoring step)', hint: 'Go a little lower — your squat depth is now at {pct}% (100% = thighs level)' },
      stand: { label: 'Drive up to standing, full hip and knee extension', hint: 'Push through your feet to stand up and straighten both hips and knees' },
    },
    lunge: {
      stance: {
        label: 'Stand sideways to the camera, upright and full body in frame',
        view: 'You look like you’re facing the camera: turn sideways (perpendicular to the lens) — angles can only be measured from the side',
        body: 'Can’t see your whole body: back up a little so you’re in frame from head to feet',
        lean: 'You’re a bit tilted or leaning forward: stand tall with your shoulders right over your hips',
        knee: 'Straighten both legs all the way',
        tune: 'Square up a little more to earn this step',
      },
      split: { label: 'Step one leg forward, feet split front and back', hint: 'Step forward — your feet are only about {pct}% apart (you need 45% or more)' },
      stride: { label: 'Make it a big stride with a wide front-to-back split', hint: 'Take a bigger step and open up the gap between your feet' },
      sink: { label: 'Bend both knees and sink down, front knee around 90°', hint: 'Bend both knees and sink down until your front knee is near 90°' },
      backknee: { label: 'Lower your back knee close to the floor (top-scoring step)', hint: 'Sink your back leg lower — bring that back knee toward the floor' },
      return: { label: 'Drive through your front foot back to standing', hint: 'Push through your front foot and stand back up straight' },
    },
    pushup: {
      setup: {
        label: 'Hands on the floor, body in one straight line',
        pose: 'Get down into position first: hands under your shoulders, body flat',
        hands: 'Your palms need to be on the floor',
        straight: 'Body must be one straight line: brace your abs and squeeze your glutes — no sagging, no piking',
        tune: 'Pull your body into one straight line to score',
      },
      lower: { label: 'Brace your core and bend your elbows to lower down', hint: 'Start lowering: bend your elbows and bring your chest toward the floor' },
      depth: { label: 'Elbows to 118° or less, chest close to the floor (top-scoring step)', hint: 'A little deeper — your elbow angle is about {deg}°' },
      press: { label: 'Press back up to fully straight arms', hint: 'Push hard and straighten your arms all the way' },
    },
    bridge: {
      setup: {
        label: 'Lie on your back with knees bent, feet hip-width apart and planted',
        pose: 'Lie down first: on your back on the mat, knees bent, feet planted',
        knee: 'Bend your knees (about 90°) and plant your feet on the floor',
        lift: 'Bring your knees up and plant your feet on the floor',
        tune: 'Lie back with your knees bent to earn this step',
      },
      lift: { label: 'Squeeze your glutes and drive your hips up', hint: 'Squeeze your glutes and drive your hips up' },
      top: { label: 'Lift until shoulders, hips and knees are almost in a straight line (top-scoring step)', hint: 'Keep pushing up until your shoulders, hips and knees are almost in one line' },
      lower: { label: 'Lower your hips back to the floor under control', hint: 'Set your hips back down to the floor under control (don’t just drop)' },
    },
    plank: {
      setup: {
        label: 'Forearms under your shoulders, push your body up',
        pose: 'Get down on the floor first: forearms directly under your shoulders, body flat',
        lift: 'Push your body up — don’t just lie on the floor',
        hands: 'Your palms or forearms need to stay on the floor',
        elbow: 'Plant your forearms (elbows about 90°), or straighten your arms fully',
      },
      align: {
        label: 'Head, back, hips and ankles in one straight line',
        sag: 'Your lower back is sagging: squeeze your glutes and brace your abs',
        pike: 'Your hips are too high: lower them until your body is in one line',
        tune: 'Brace your core so shoulders, hips and ankles form one line',
      },
      hold3: { label: 'Hold steady for 3 seconds' },
      hold10: { label: 'Hold steady for 10 seconds' },
      hold30: { label: 'Hold steady for 30 seconds' },
    },
    repStand: {
      stance: {
        label: 'Stand in your starting position with both feet planted',
        hint: 'Set up first: legs almost straight and your weight settled',
      },
      lower: {
        label: 'Bend your knees and sink down',
        hint: 'Start sinking: hips back and down, knees tracking over your toes',
      },
      bottom: {
        label: 'Reach the target depth (top-scoring step)',
        hint: 'A little deeper — take the movement all the way',
      },
      up: {
        label: 'Drive back up to the start position',
        hint: 'Return to the start position to complete the rep',
      },
    },
    jumpingJack: {
      stance: {
        label: 'Stand with your feet together and arms at your sides',
        hint: 'Start with your feet together and your arms down by your sides',
      },
      open: {
        label: 'Jump your feet wide and raise both arms',
        hint: 'Open up: jump your feet out to the sides and your hands overhead',
      },
      wide: {
        label: 'Reach the widest spread (top-scoring step)',
        hint: 'A little wider — feet all the way open, arms straight up',
      },
      close: {
        label: 'Jump back together to the start position',
        hint: 'Feet back together and arms down completes the rep',
      },
    },
    repSupine: {
      setup: {
        label: 'Lie down and set up your starting position',
        hint: 'Lie on your back and get into your starting position first',
      },
      engage: {
        label: 'Brace your abs and start the movement',
        hint: 'Drive from your abs and start lifting',
      },
      top: {
        label: 'Lift to the target position (top-scoring step)',
        hint: 'Lift a little higher — take it all the way',
      },
      lower: {
        label: 'Lower back down under control',
        hint: 'Lower slowly — no swinging',
      },
    },
    repAlt: {
      setup: {
        label: 'Set up your support position and stay stable',
        hint: 'Set up your position before you start alternating',
      },
      first: {
        label: 'Complete the first rep on one side',
        hint: 'Start on one side: tuck or reach on that side while the other side stays still',
      },
      switch: {
        label: 'Switch to the other side and keep alternating',
        hint: 'Switch to the other side and keep going',
      },
      rhythm: {
        label: 'Keep a steady alternating rhythm',
        hint: 'Hold the rhythm — a few reps on each side',
      },
    },
    standAlt: {
      setup: {
        label: 'Stand tall with room in front and behind',
        hint: 'Stand tall and leave room front and back, then start kicking your heels up',
      },
      first: {
        label: 'Kick one heel up',
        hint: 'Kick one heel up towards your glutes to start',
      },
      switch: {
        label: 'Switch legs and keep alternating',
        hint: 'Switch to the other leg and keep alternating',
      },
      rhythm: {
        label: 'Keep a steady alternating rhythm',
        hint: 'Hold the rhythm — a few kicks on each leg',
      },
    },
    sequence: {
      setup: {
        label: 'Stand up and get ready for the whole sequence',
        hint: 'Stand tall and get ready',
      },
      down: {
        label: 'Squat down and plant your hands',
        hint: 'Squat down and put both hands on the floor',
      },
      middle: {
        label: 'Complete the middle of the sequence',
        hint: 'Take your body into one straight line',
      },
      finish: {
        label: 'Stand up and finish the sequence',
        hint: 'Pull your legs in, stand up and finish the rep',
      },
    },
    jump: {
      stance: {
        label: 'Stand up and get ready to jump',
        hint: 'Get set with both feet planted',
      },
      crouch: {
        label: 'Bend your knees and swing your arms back',
        hint: 'Sink down and load your arms back',
      },
      flight: {
        label: 'Drive off the floor so both feet leave the ground (top-scoring step)',
        hint: 'Jump hard so both feet come off the floor',
      },
      land: {
        label: 'Land with soft knees and stand steady',
        hint: 'Land with bent knees, stand steady, then go again',
      },
    },
    holdPose: {
      pose: {
        label: 'Set up the position for this move',
        hint: 'Get into position before the timer starts',
      },
      align: {
        label: 'Body in one line / holding steady',
        hint: 'Tighten into one line and hold steady',
      },
      hold3: {
        label: 'Hold for 3 seconds',
      },
      hold10: {
        label: 'Hold for 10 seconds',
      },
      hold30: {
        label: 'Hold for 30 seconds',
      },
    },
    stretchHold: {
      pose: {
        label: 'Ease slowly into the stretch',
        hint: 'Ease into the stretch slowly — no bouncing',
      },
      settle: {
        label: 'Breathe and feel the stretch',
        hint: 'Relax and breathe — a gentle stretch is enough',
      },
      hold10: {
        label: 'Hold for 10 seconds',
      },
      hold20: {
        label: 'Hold for 20 seconds',
      },
    },
  },

  /* ---------------- Exercise categories ---------------- */
  cat: {
    title: 'Categories',
    upper: 'Upper body',
    lower: 'Lower body',
    core: 'Core',
    full: 'Full body',
    stretch: 'Stretching',
  },

  /* ---------------- Exercise library home ---------------- */
  home: {
    title: 'Pick an exercise',
    subtitle: 'Choose a category and tap an exercise to start — the camera tracks you live and coaches you by voice',
    count: '{n} exercises',
    search: 'Search exercises',
    noResult: 'No matching exercise found',
    back: 'Back to home',
    openSettings: 'Settings',
    // Two new top-bar icons (their contents live in modals)
    openBest: 'Best scores',
    openHistory: 'Workout history',
    rough: 'Rough scoring',
    judgeBy: 'Scored by: {what}',
    start: 'Start training',
    recent: 'Recently trained',
  },

  /* ---------------- Per-exercise settings ---------------- */
  exercise: {
    open: 'Exercise settings',
    title: 'Exercise settings',
    close: 'Close',
    lead: 'These settings apply to the current exercise only',
    targetGroup: '🎯 Target',
    target: 'Set target',
    // Timed counting (Jumping Jack): the target is a duration, the result is the reps done inside it
    timedLead: '⏱ Timed counting: this set runs for a fixed {sec} seconds and settles automatically when the time is up; '
      + 'the result is how many reps you fitted into those {sec} seconds (reps are still counted keyframe by keyframe, '
      + 'and reaching a rep target never cuts the set short).',
    judgeGroup: '⚖️ Counting rule',
    judgeBy: 'Judged by: {what}',
    rough: 'Rough judgement',
    specGroup: '📐 Keyframe criteria and scoring',
    specLead: 'Each row below is one keyframe on the progress bar: its criterion and its points are '
      + 'the exact rules the detector runs. Clear a keyframe and it lights up; clear all of them and the rep counts.',
    cameraGroup: '📹 Camera placement',
    camera: 'Camera hint: {what}',
  },

  /* ---------------- Settings ---------------- */
  /* Text for the two modals (best scores / workout history) */
  records: {
    bestLead: 'Your best set per exercise (reps / duration plus score), stored only in this browser on this device.',
    historyLead: 'Your last 12 sets: time, exercise, result and score.',
    cleared: 'History cleared (best scores were cleared with it)',
  },

  settings: {
    title: 'Settings',
    close: 'Close',
    language: 'Language',
    model: 'Pose model',
    modelHint: 'Lite runs smoother, Full is more accurate (the first switch downloads a few dozen MB, then it works offline)',
    sound: 'Sound',
    musicTrack: '🎵 Background track',
    cameraGroup: 'Video & tracking',
    view: 'Interface',
  },

  /* ---------------- What each exercise is scored by ---------------- */
  judge: {
    elbow: 'Elbow bend',
    knee: 'Knee bend',
    hip: 'Hip hinge',
    ankle: 'Heel lift',
    rise: 'Hip lift height',
    clear: 'How far your body leaves the floor',
    flight: 'Both feet off the floor (jump)',
    twist: 'Torso rotation',
    sequence: 'Order of the whole sequence',
    arm: 'Single-arm raise',
    leg: 'Left/right leg alternation',
    spread: 'How wide your legs open',
    pose: 'Whether your body position is on target',
    time: 'Hold time',
  },

  /* ---------------- Live form cues ---------------- */
  /* ---------------- Technical thresholds shown in the exercise-settings modal ---------------- */
  metric: {
    knee: 'Knee angle',
    kneeBent: 'Knee bend',
    kneeExtended: 'Leg extension',
    frontKnee: 'Front knee bend',
    straighterKnee: 'Bend of the straighter leg',
    elbow: 'Elbow angle',
    hip: 'Hip angle',
    ankleSpread: 'Ankle separation',
    kneeSpread: 'Knee separation',
    // The jumping jack now measures whichever is wider (knees or ankles): real jacks spread the feet further
    legSpread: 'Leg spread',
    body: 'Body line angle',
    trunk: 'Trunk tilt',
    torsoIncl: 'Trunk tilt',
    // Crunch: shoulder-hip distance / lying length (a pure ratio), and head height off the floor
    torsoShrink: 'Shoulder-hip distance',
    headClear: 'Head off floor',
    hipAboveKnee: 'Hip above knee',
    hipRise: 'Hip lift',
    // Criterion name for the standing gate: how much higher the shoulders are than the hips
    shoulderAboveHip: 'Shoulders above hips',
    hipClear: 'Hip height off the floor',
    kneeClear: 'Knee height off the floor',
    shoulderClear: 'Shoulder height off the floor',
    // Shoulder joint angle (hip-shoulder-elbow) - the plank judges "are you propped up" with it
    shoulderAngle: 'Shoulder joint angle',
    // "Trunk tilt + hip angle" sum: the seated forward fold identity (~90 deg)
    foldSum: 'Trunk + hip angle',
    wristClear: 'Hand height off the floor',
    wristClearMin: 'Hand height off the floor',
    backKneeDrop: 'Back knee height off the floor',
    shoulderDrop: 'Shoulder drop',
    hipLineDevAbs: 'Deviation',
    valgus: 'Knee valgus',
    lift: 'Lift off the floor',
    oneSide: 'Knee angle on the working side',
    otherSide: 'Knee angle on the other side',
    // Dead bug: the criterion is "how far the leg reaches out" = the smaller of knee and hip angle
    oneSideLeg: 'Reach of the extending leg (smaller of knee/hip)',
    otherSideLeg: 'Reach of the other leg (smaller of knee/hip)',
  },

  spec: {
    group: {
      keyframes: '🎬 Keyframes and scoring (the segments on the progress bar)',
      count: 'Counting rules (how far a rep has to go to count)',
      posture: 'Posture required (otherwise nothing is judged)',
      advice: 'Form reminders (spoken only, never costs reps)',
    },
    countMoment: 'rep counted here',
    holdMoment: 'timer starts',
    roundBonus: 'perfect round',
    perSecondSuffix: '/s',
    orAlt: 'or',
    andAlso: 'and',
    poseExtra: 'Also required: ',
    depthLine: 'Full depth (earns the depth points): ',
    wobbleLine: 'Anything shallower is just a wobble: ',
    tempoLine: 'Shortest rep: ',
    holdPrimeLine: 'Timer starts once the pose holds: ',
    holdGraceLine: 'Grace period (small wobbles never interrupt): ',
    keyframesNote: '{n} segments: {every} the moment the last one lights up is the moment the rep is counted '
      + '(for timed exercises, when the timer starts) — that segment is also what closes “all keyframes done”. '
      + 'The segment scores plus the perfect-round bonus add up to {total} points per round.',
    everyFrameNeeded: 'every segment is a condition the rep must meet, in judging order;',
    unit: {
      deg: '°',
      torso: '× torso length',
      shin: '× shin length',
      lift: '× frame height',
      s: 's',
      count: '×',
      // Pure ratio (the crunch's "shoulder-hip distance / lying length"): it cannot read "× torso length",
      // because that unit *is* the shoulder-hip distance itself
      ratio: '× lying length',
    },
    enterLine: 'Starts the rep',
    countLine: 'Counts as one rep (relaxed mode)',
    bottomLine: 'Full depth (earns full depth points)',
    backLine: 'Back to the start position (rep ends)',
    wobble: 'Mere wobble',
    minRep: 'Shortest rep time',
    flight: 'Feet off the floor',
    giveUp: 'Longest rep time',
    lungeEnter: 'Starts the rep',
    bothKnees: 'Both knees must bend (the straighter leg)',
    pushupEnter: 'Starts the rep',
    shoulderDrop: 'Shoulder drop',
    pushupPose: 'Push-up plank position',
    squatEnter: 'Starts the rep',
    bridgeDown: 'Back down on the floor (start position)',
    // The glute bridge's angle path (an “or” with the height line); the bar still labels it “Lift”
    bridgeCountAngle: 'Shoulders–hips–knees in one line (angle path)',
    bridgeSupine: 'Supine bent-knee position',
    plankHard: 'Held up (required)',
    plankSoft: 'Body in one line (recommended)',
    // Seated forward fold (the user's kinematic description): (1) the seated start pose, (2) folded = timer starts
    seatedStart: 'Sit up (starting pose)',
    seatedFold: 'Folded far enough (timer starts)',
    plankKnee: 'Knees off the floor (recommended)',
    // Crunch (the user's model): (1) lie down with knees bent (2) trunk tilt shrinks (3) shoulder-hip distance ≈70-80%, or the head leaves the floor
    crunchLying: 'Lie down with knees bent (starting pose)',
    crunchTilt: 'Trunk tilt shrinks (curling up)',
    crunchShrink: 'Shoulder-hip distance down to 70%-80% of lying',
    crunchHead: 'Head off the floor',
    crunchHands: 'Do not pull on your neck (recommended)',
    holdPrime: 'Timer starts once the pose is steady',
    holdGrace: 'Grace time when the pose breaks',
    holdStraight: 'Body line angle',
    pose: {
      stand: 'Standing position',
      standUpright: 'Standing upright (no floor line needed)',
      standWide: 'Standing, legs apart',
      prone: 'Push-up position',
      supine: 'Lying on your back, knees bent',
      supineLow: 'Lying on your back',
      supineFlat: 'Lying on your back',
      standFold: 'Standing forward fold',
      seatedFold: 'Seated forward fold',
    },
    postureKeep: 'Hold the movement position',
    startStance: 'Starting stance',
    leanMax: 'Keep your torso upright',
    viewFront: 'Camera placement',
    viewSide: 'Camera placement',
    adviceStraight: 'Keep the body in one line',
    adviceHip: 'Sagging / piked hips',
    adviceValgus: 'Keep your knees from caving in',
    adviceLean: 'Keep your torso upright',
    adviceBackKnee: 'Back knee close to the floor',
    adviceLegStraight: 'Keep the leg straight (knee angle)',
    altOn: 'One side enters the movement',
    altSwitch: 'The other side does it too',
    // Dead bug: keyframes say what this exercise actually does — "extend one leg" / "extend the other"
    altOnDeadBug: 'Extend one leg',
    altSwitchDeadBug: 'Extend the other leg too',
    // Butt kick: the user asked for "kick" / "kick the other leg"
    altOnButtKick: 'Kick (heel up toward your glutes)',
    altSwitchButtKick: 'Kick the other leg (counts at the switch)',
    altOtherHold: 'Keep the other leg in the tabletop',
    altHold: 'How long the movement must be held',
    altGap: 'Gap between two counted reps',
    twistAmount: 'Twist range of the upper body',
    seq1: 'Stage 1: stand tall',
    seq2: 'Stage 2: crouch',
    seq3: 'Stage 3: plank',
    seq4: 'Stage 4: jump',
    seqWindow: 'Time limit for the whole sequence',
    /* Judgement progress bar: each icon's short label is used in the hover tooltip */
    short: {
      stance: 'Stance',
      stand: 'Stand',
      start: 'Start',
      count: 'Count',
      full: 'Full',
      both: 'Both',
      jump: 'Jump',
      down: 'Back down',
      back: 'Return',
      drop: 'Sink',
      work: 'Work',
      rest: 'Return',
      // Last segment for alternating exercises: the other leg does it too (that is the counting moment)
      switch: 'Switch',
      // Dead bug: extend a leg / extend the other leg
      extend: 'Extend',
      extendOther: 'Switch',
      // Butt kick: kick / kick the other leg
      tuck: 'Kick',
      tuckOther: 'Other leg',
      prone: 'Plank',
      supine: 'Supine',
      side: 'Side',
      seat: 'Seated',
      fold: 'Fold',
      holdPlank: 'Held up',
      // Crunch's three segments: lie down → curl → curled into place (counts)
      crunchLie: 'Lie',
      crunchCurl: 'Curl',
      crunchTop: 'Curled',
      // Plank, second segment: shoulder joint angle (arms propping you up)
      prop: 'Arms propped',
      lift: 'Off floor',
      hands: 'Hands down',
      hip: 'Hips',
      knee: 'Knees up',
      line: 'In line',
      crouch: 'Crouch',
      holdTime: 'Hold',
      pose: 'Pose',
      step: 'Step',
    },
    note: {
      enterLine: 'A rep only starts once you bend past this line.',
      looseMode: 'Reaching this line counts a rep (there is only this one relaxed tier: a roughly completed rep counts and depth points follow how deep you actually went).',
      bottomLine: 'Reaching this line is full depth — depth and bonus points are scored from it.',
      adaptive: 'The start position follows you: it is based on the largest range you actually reached in the last 1.5 s, so coming back near your own start closes the rep.',
      wobble: 'Below even this range: not counted and nothing is spoken.',
      flight: 'Jumping exercises also require the lift to pass this line.',
      giveUp: 'A rep stuck longer than this is force-settled (and counts if deep enough) — reps are never swallowed.',
      pushupEnter: 'Bending {v}° below your own top counts as “starting to lower” (the bar\u2019s third segment) — people who cannot straighten their arms are still recognised (a side camera flattens the elbow reading).',
      pushupBottom: '**Reaching this line counts the rep** (the user\u2019s latest rule: “the count does not have to be at the lowest point”): '
        + 'the very frame your elbow reaches the counting line (146° by default, and it follows your own top — someone whose top is only 150° gets 142°) '
        + 'the rep is counted: the call-out, the sound and the counter all fire right then, with no need to wait for the press and no need to pause at the bottom. '
        + 'The only follow-up requirement is that you **push back to your top** before the next rep can start '
        + '(so resting on the counting line cannot farm reps). Going deeper than the line still earns more depth credit (down to {full}° for full marks).',
      shoulderDrop: 'Looking down at a laptop screen flattens the elbow angle, so this signal is used alongside it: the shoulders dropping {start} already starts the rep, dropping to the line above counts a rep, and {full} earns full depth credit. Closing a rep needs the shoulders back within {ret} of your top (between “start” and “count”, so a rep cannot be called done the moment you begin to sink).',
      pushupTempo: 'The debounce only filters reading spikes: the depth line must **hold for {dwell} ms** (about two frames) before the rep counts, and two reps are at least this far apart. A real push-up is far slower than both — slower and shallower reps still count.',
      squatBottom: 'Squat until the thighs are close to horizontal (hip level with knee = 0).',
      squatLean: 'With a front-facing camera, leaning past this angle does not count as the standing stance.',
      startStand: 'Each rep starts from standing: come back up before the next one.',
      lean: 'Leaning past this angle triggers a spoken reminder.',
      bridgeDown: 'The hips must come back down to the floor (within a little of your own lowest point) to finish a rep — **the moment this keyframe lights up is the moment the rep is counted**.',
      bridgeCount: 'Lifting the hips past this line is what makes it “up” (the line follows your own lowest point); lifting higher scores higher, and the rep itself is counted when you come back down.',
      bridgeAngle: '**Angle path** (an “or” with the height line above): the on-screen “Hip” readout *is* the shoulders–hips–knees angle — about 135°–145° lying flat with bent knees, about 170°–180° when lifted into one line. The user measured that “the hips hit their highest point at about 170°”, so reaching that angle counts as “up” — you no longer have to hit a specific height (which also covers people whose shoulders lift with them, or who have a long torso).',
      bridgeKnee: 'The knee angle must stay inside this range: too small means no knee bend, too large means the leg is straight.',
      // Crunch (the user's model, see CRUNCH in exercises.js)
      crunchLying: '**The starting pose is “lie down with knees bent”**: lie on your back sideways to the camera — trunk close to horizontal (tilt ≥ {tilt}°, flat is about 90°), knees bent (knee angle around 90°).',
      crunchKnee: 'Lying with bent knees: the knee angle must fall inside this range (too small means no bend at all, too large means the leg is straight — that is a leg raise).',
      crunchTilt: '**“Curling up” is judged by how many degrees you lose against your own lying pose** (≥ {drop}°), not by a fixed angle —'
        + ' the lying baseline follows your own readings (the largest value among frames with trunk tilt ≥ {floor}°),'
        + ' so a slightly off camera or a soft mat still works.',
      crunchShrink: '**The shoulder-to-hip length**: as you curl, the trunk folds and this length shrinks noticeably —'
        + ' it starts around {start} and **{count}** already counts as a rep (the user measured about {full} in practice; this line keeps a margin).'
        + ' The denominator is *your own lying length*, so body type, distance from the camera and camera angle do not matter.',
      crunchHead: '**Head off the floor** (another key signal, and an OR with the shrink line above):'
        + ' the head (nose/ear) leaving the floor by more than this line counts as curled — it catches small, quick reps.',
      crunchTempo: 'At least this long between two crunches: it only filters out wobbles faster than a human can move; slower and shallower reps still count.',
      crunchHands: 'If you put your hands behind your head, do not pull with your neck — cross your arms on your chest or rest your fingertips by your ears instead.',
      bridgeTempo: 'A whole round (leaving the floor → back on the floor) has to take at least this long; it only filters out a quick bounce.',
      bothKnees: 'The straighter leg (usually the back one) must also bend past this line, or {v}° below how straight you personally stand, whichever is stricter. Moving only the front leg is logged as a partial rep.',
      lungeCount: 'Bending the front knee past this line already counts (no 90° required); if you stand straighter and read a lower angle, the line adapts to you.',
      lungeEnter: 'This much bend from standing starts the rep.',
      plankHard: 'Required: the body must be held up (close to horizontal, arms propping you) before the timer runs, otherwise it pauses.',
      plankPropped: 'Whether you are propped up is judged by an **angle**: the shoulder joint angle (hip-shoulder-elbow) has to land in this range — the upper arm clearly pushing down. '
        + 'Measured: a forearm plank is about 90°, a straight-arm plank about 90°, and any elbow angle around {elbow}° counts; “lying flat and resting with the arms at your sides” reads only about 10° and is rejected. '
        + '**Or** the older rule still works: shoulders at least {clear}× torso off the floor **and** hands/forearms within {hand}× torso of the floor (both at once). '
        + 'That used to be the only rule, and on a bed or sofa — or with a slightly off camera — it measured the hands as 0.6+ above the floor and never started the timer (user report).',
      plankSoft: 'Recommended: falling short only triggers a spoken reminder, the timer keeps running.',
      handOnFloor: 'Hands or forearms must be near the floor; propping on a chair or step goes past this line.',
      holdPrime: 'The timer only starts after the pose has been steady this long (avoids momentary misreads).',
      holdGrace: 'A brief break in the pose (tracking noise) does not stop the timer within this long.',
      // Seated forward fold (the user's kinematic description)
      seatedStart: '**The starting pose is simply “sitting up”**: sideways to the camera, sitting tall — trunk essentially vertical (≤{trunk}°), '
        + 'hip angle around {hipMin}°–{hipMax}° (thighs flat in front of you), legs straight (knee ≥{knee}°) and sitting on the mat (hips not above the knees). '
        + 'Once this pose has been seen it **stays lit**, so folding forward never cancels it — the segment asks “did you sit up”, not “are you sitting tall right now”.',
      seatedFold: '**Folding far enough starts the timer**: the trunk leans ≥{trunk}° forward (the user: “around 30° of trunk angle is basically there”). '
        + 'It also needs the legs still straight (knee ≥{knee}°), the hips not above the knees (≤{hipAbove}× shin length, i.e. still seated), '
        + 'and **trunk angle + hip angle ≈ {sumMin}°–{sumMax}°** — the kinematics the user described: sitting with the legs flat, the hip angle is 90° minus the trunk tilt, '
        + 'so the two always add up to about 90°; standing folds read about 180° and lying poses 180°–270°, so this line rules those out.',
      holdPosture: 'A clearly broken body line triggers a spoken reminder but does not stop the timer straight away.',
      pushupPose: 'The rep is only judged while you are in the push-up plank position (down on the floor, hands planted).',
      bodyStraight: 'A body that is not in one line only triggers a spoken reminder and a discounted quality score — it never costs you a rep.',
      shoulderOnFloor: 'The shoulders must stay on the floor (past this line means you are not lying down).',
      altOn: 'One side has to enter this range to count as “working”.',
      altSwitch: 'The other side has to reach the same range ({dir}{v}°); the moment the switch lands, one rep is counted. '
        + 'The side you just used has to come back to {rel}{rest}°, and two reps have to be at least {gap} s apart.',
      altHold: 'The working side has to stay there this long to count once (filters out jitter).',
      altGap: 'At least this much time between two counted reps.',
      altOtherHold: '**The other leg has to stay in the starting position** (for the dead bug: the bent-knee tabletop at 90°) — '
        + 'when this does not hold, that frame is not counted, because “both legs extending at once” is a different exercise, not the dead bug alternation.',
      supineLying: 'There are **two ways to prove you are lying down, and either one is enough**: the torso is close to horizontal in '
        + 'the frame (no ground line involved) **or** the shoulders are within this distance of the ground line. Why both: on a bed or sofa, '
        + 'or with the camera at your feet, the ground line sits below your body and the shoulder height alone would call a perfectly flat '
        + 'position “not lying down”.',
      altOnDeadBug: 'The dead bug judges how far the **leg reaches out**, not how much the knee bends: this number is the **smaller of the knee angle and the hip angle** — '
        + 'the knee has to be close to straight AND the thigh has to genuinely open away from the tabletop (≈90°). Both must arrive, so “thigh still vertical, only the shin kicked straight up” does not count, '
        + 'and neither does “leg lowered but the knee still bent”.',
      altSwitchDeadBug: 'The other leg has to reach out the same way ({dir}{v}°); the moment the switch lands, one rep is counted. '
        + 'The leg you just extended has to return to the tabletop first ({rel}{rest}°), and two reps have to be at least {gap} s apart.',
      twistAmount: 'The upper body must twist past this range to count a twist.',
      sequence: 'Stage {n}/{total}: every stage has to be hit in order.',
      seqWindow: 'The whole sequence must finish within this time, otherwise counting restarts.',
      adviceOnly: 'Spoken reminder only — it does not block counting (the quality score is discounted).',
    },
    text: {
      viewFront: 'Face the camera (these rules are measured from the front)',
      viewSide: 'Stand sideways to the camera (these rules are measured from the side)',
      lungeBack: 'Rise {pct}% of the way back from this rep’s deepest point, or {deg}° above it',
      lungeWobble: 'Less than {deg}° below how straight you stand: not counted and nothing is spoken',
      pushupWobble: 'Less than {deg}° below your own top and no shoulder drop: not counted and nothing is spoken',
      crunchTilt: 'More than {drop}° less than your own lying pose (flat is about 90°, curled into place about 70°)',
      crunchHands: 'Cross your arms on your chest or rest your fingertips by your ears — do not pull yourself up with your neck',
      outOfPose: 'Return to the starting position of this exercise',
    },
  },

  cue: {
    depth: 'A bit more range — go deeper next time',
    tempo: 'Slow down and keep the rhythm',
    notReady: 'You’re not in position for this move yet — set up as shown first',
    // Seated forward fold: sit up first (the starting pose), then fold
    notSeated: 'Sit up first: sideways to the camera, sitting tall with your legs straight (hip angle about 90°, trunk vertical), then fold forward',
    moreRange: 'Bigger range — move all the way for it to count',
    needJump: 'You need to jump: both feet off the floor to count',
    tooFast: 'Slow down — that was too fast',
    keepStraight: 'Keep your body in one straight line — no sagging, no piking',
    sag: 'Your lower back is sagging: tighten your abs and lift your hips in line with your body',
    pike: 'Your hips are piked too high: flatten your pelvis so your body is one line',
    valgus: 'Don’t let your knees cave in — push them out over your toes',
    lean: 'Keep your torso upright — don’t lean or tilt forward',
    pose: 'Your form has drifted off the target — fix it before you continue',
    bothKnees: 'Bend both legs — the back leg has to bend and sink down too',
    straightLegs: 'Keep the leg straight — don’t bend the knee, lift the whole leg with your core',
    otherSide: 'One leg at a time — keep the other leg bent at 90° in the tabletop instead of extending it too',
  },

  /* ---------------- Movement-family form templates ---------------- */
  fam: {
    repStand: {
      howto: ['Stand tall with both feet planted', 'Send your hips back and down, bending your knees over your toes', 'Reach the target depth, then drive back up to standing'],
      tips: ['Don’t let your knees cave inward', 'Keep your back straight — don’t round it', 'Keep your weight over your whole foot'],
    },
    repSupine: {
      howto: ['Lie on your back on the mat and set up your starting position', 'Brace your abs and lift your body or legs to the target', 'Lower back to the start position under control'],
      tips: ['Chin slightly tucked — don’t strain your neck', 'Drive with your abs the whole time and keep breathing', 'Lower under control — don’t drop or crash down'],
    },
    repAlt: {
      howto: ['Set up your support position with your core tight and your body stable', 'Tuck or reach on one side while the other side stays still', 'Alternate sides with an even rhythm'],
      tips: ['Don’t let your hips swing side to side', 'Slower beats faster here', 'Stop if your lower back complains'],
    },
    standAlt: {
      howto: ['Stand side-on to the camera with soft knees and an upright torso', 'Bounce lightly in place and kick one heel up towards your glutes', 'Switch legs and keep alternating with an even rhythm'],
      tips: ['Get the heel as close to your glutes as you can — a partial kick still counts', 'Keep your torso upright and your eyes ahead, don’t lean forward or look down', 'Land softly on the balls of your feet'],
    },
    sequence: {
      howto: ['Stand up, then squat down and put your hands on the floor', 'Jump both feet back into a plank (add a push-up if you like)', 'Pull your legs in, stand up and finish with a jump'],
      tips: ['Land with bent knees to absorb the impact', 'If you’re tired, skip the push-up part', 'The whole sequence has to flow for it to count as one rep'],
    },
    jump: {
      howto: ['Stand up, bend your knees and swing your arms back to load', 'Drive off the ground and jump — both feet leave the floor', 'Land with soft knees and stand steady before the next rep'],
      tips: ['Land softly and don’t lock your knees', 'Height doesn’t matter — getting off the floor counts', 'Do these on a softer surface or a mat'],
    },
    holdPose: {
      howto: ['Set up the position for this move', 'Tighten your core and hold one straight line or stay stable', 'Breathe evenly and hold for the target time'],
      tips: ['If your form breaks the timer pauses — fix it and the timer resumes', 'Start with a shorter target time if it feels tough', 'Stop right away if your lower back hurts'],
    },
    stretchHold: {
      howto: ['Ease into the stretch slowly — no bouncing', 'A gentle stretch is enough — don’t chase pain', 'Keep breathing and hold for 20–30 seconds'],
      tips: ['Warm your joints up before you stretch', 'Stretch both sides and keep the times even', 'Don’t hold your breath — slow exhales help you relax'],
    },
  },

  /* ---------------- Form cues ---------------- */
  /* ---------------- 背景音乐曲目 ---------------- */
  music: {
    track: {
      cityRun: 'City Run',
      neonPulse: 'Neon Pulse',
      sunriseFunk: 'Sunrise Funk',
      powerDrive: 'Power Drive',
    },
  },

  cues: {
    squat: {
      valgus: 'Don’t let your knees cave in — push them out over your toes',
      lateral: 'Don’t tilt: stay symmetrical side to side and keep your shoulders stacked right over your hips',
      depth: 'Go lower — squat until your thighs are near horizontal',
      depthAborted: 'Squat deeper — partial reps don’t count',
      halfway: 'Squat until your thighs are parallel to the floor, then stand up',
      tempo: 'Too fast — lower slowly, pause for a beat, then stand up',
    },
    lunge: {
      backknee: 'Sink your back knee lower, close to the floor',
      lean: 'Keep your torso upright — don’t lean forward',
      lungeDepth: 'Sink lower: front knee around 90°, back knee close to the floor',
      bothKnees: 'Bend both legs: the back leg has to bend and sink too, not just a quick dip of the front leg',
      tempo: 'Slow down — control both the sink and the way up',
      alternate: 'Switch legs — alternate sides each rep',
    },
    pushup: {
      sag: 'Your hips are sagging — squeeze your glutes and brace your core',
      pike: 'Your hips are too high — flatten your body into one line',
      body: 'That rep was off the line — re-brace your core and go again',
      depth: 'A little deeper — bend your elbows to 90° or less',
      tempo: 'Slow down — control the lower',
    },
    bridge: {
      notSupine: 'Glute bridges are done lying down — lie on your back and bend your knees',
      riseMore: 'Drive your hips higher — until your thighs and torso form one line',
      tempo: 'Lift and lower slowly — no momentum',
    },
    plank: {
      lift: 'Push your body up — don’t just lie on the floor',
      pose: 'Get down on your forearms or hands and keep your body flat',
      sag: 'Your lower back is sagging — squeeze your glutes and brace your abs',
      pike: 'Your hips are too high — lower them into one line',
      straight: 'Body must be one straight line: brace your core and squeeze your glutes',
      hands: 'Your palms or forearms need to stay on the floor',
      knees: 'Knees off the floor — support yourself on your toes',
      elbow: 'Plant your forearms (elbows about 90°), or straighten your arms fully',
    },
  },

  /* ---------------- Speech ---------------- */
  speech: {
    // Encouragement pool (the user asked for more emotional payoff): praise out loud, cycled in order
    encourage: [
      'Keep going', 'Great job', 'Excellent', 'Well done', 'Beautiful', 'Very nice',
      'Perfect', 'Right on rhythm', 'Hold it', 'Stay steady', 'Great pacing', 'Keep it up',
      'Stay with it', 'Do not stop', 'Looking strong', 'Getting smoother', 'Solid set', 'Keep breathing',
      'A little more', 'You are crushing it', 'So much grit', 'Form is looking great', 'Rooting for you', 'Nice, just like that',
    ],
    // A louder line for a round with every keyframe cleared (perfect-round bonus)
    praiseRound: ['Perfect!', 'Full marks, beautiful', 'Textbook form!', 'Spot on — every keyframe'],
    // Appended to the set result when a set ends
    praiseSet: ['Great work, give yourself a pat on the back', 'Nice session, you look strong today', 'Strong set, remember to hydrate', 'Keep it up, I love watching you train'],
    repSuffix: '',
    secondSuffix: 'seconds',
    // Screen text only — the voice never reads the score (the user asked for that)
    scoreSuffix: 'points',
    start: 'Go',
    half: 'Halfway there, keep it up',
    voiceTest: 'Voice is on',
    goal: 'Goal reached, awesome',
    noPerson: 'Step into the middle of the frame and keep your whole body in view',
    nextStep: 'Next: {label}. {hint}',
    nextStepNoHint: 'Next: {label}',
    // Spoken set result: **reps / duration plus a cheer, never the score** (the user asked for that)
    setSummary: 'That set: {value} {unit} — {praise}',
    // Timed counting (Jumping Jack): announce how many reps fitted into the duration
    timedSummary: '{value} reps in {sec} seconds — {praise}',
    // Runs of timed counting: remaining-time calls (periodic + the last five seconds)
    timeLeft: '{n} seconds left',
    timeLast5: 'Last 5 seconds — push!',
  },
};
