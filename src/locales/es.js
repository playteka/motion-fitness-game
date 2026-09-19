/**
 * Localización al español (es-ES, español de España neutro, trato de «tú»).
 * La estructura de claves debe ser idéntica a la de zh.js: cualquier clave que
 * falte se sustituye por la del inglés.
 */

export default {
  meta: {
    code: 'es',
    label: 'Español',
    flag: '🇪🇸',
    htmlLang: 'es',
    speechLang: 'es-ES',
    title: 'Fitness por movimiento · Conteo de repeticiones y cronómetro',
  },

  app: {
    brand: 'Fitness por movimiento',
    subtitle: 'Más de 60 ejercicios con cámara · Tren superior / Tren inferior / Core / Cuerpo completo / Estiramientos · Conteo y cronómetro · Puntos paso a paso según la técnica',
  },

  /* ---------------- Interfaz ---------------- */
  ui: {
    kindRep: "Conteo",
    kindHold: "Cronómetro",
    shortcutsText: "<kbd>1</kbd>–<kbd>9</kbd> Cambio rápido · <kbd>H</kbd> Inicio · <kbd>G</kbd> Ajustes · <kbd>Espacio</kbd> Iniciar/Pausar · <kbd>R</kbd> Reiniciar · <kbd>Esc</kbd> Terminar serie · <kbd>M</kbd> Espejo · <kbd>S</kbd> Esqueleto · <kbd>F</kbd> Pantalla completa",
    language: 'Idioma',
    model: 'Modelo',
    modelLite: 'Ligero (fluido)',
    modelFull: 'Completo (más preciso)',
    mirror: '🪞 Espejo',
    voice: '🔊 Voz con conteo',
    sfx: '🎵 Sonidos',
    music: '🎶 Música',
    strict: '✅ Modo estricto',
    skeleton: '🦴 Esqueleto',
    angles: '📐 Ángulos',
    debug: '🐞 Métricas',
    fullscreen: 'Pantalla completa del vídeo',

    startCam: 'Activar la cámara',
    retry: 'Reintentar',
    camera: 'Cámara',
    lens: 'Lente',
    resetReps: 'Reiniciar el conteo',

    step1: '① Elige el ejercicio',
    step2: '② Fija tu objetivo',
    step3: '③ Empieza a entrenar',
    actionGuide: 'Técnica',
    scoreCard: 'Puntos de técnica',
    best: 'Mejor marca',
    history: 'Historial',
    clear: 'Borrar',
    shortcuts: 'Atajos',

    start: 'Empezar',
    pause: 'Pausa',
    resume: 'Continuar',
    stop: 'Terminar la serie',
    training: 'Entrenando…',

    totalScore: 'Puntos totales',
    validReps: 'Reps válidas',
    partial: 'Parcial / No cuenta',
    setTime: 'Tiempo de la serie',
    holdTime: 'Tiempo aguantado',
    depth: 'Amplitud',
    targetPrefix: 'Objetivo',
    repsUnit: 'reps',
    secondsUnit: 's',

    summaryTitle: 'Resumen de la serie',
    colAction: 'Ejercicio',
    colScore: 'Puntos',
    colValidReps: 'Reps válidas',
    colHold: 'Tiempo válido',
    colCompletion: 'Cumplimiento',
    colSteps: 'Pasos logrados',
    colElapsed: 'Duración',
    stepsDoneRatio: '{done}/{total} pasos',

    noRecords: 'Todavía no hay registros. ¡Haz una serie para empezar!',
    noHistory: 'Todavía no hay entrenamientos.',
    clearConfirm: '¿Seguro que quieres borrar todo el historial y las mejores marcas?',

    stepsNote: 'Sigue los pasos uno a uno: cada vez que cumplas uno, sumas puntos al momento, suena un aviso y se marca; y si completas todos los pasos de la ronda, te llevas un bonus por puntuación máxima.',
    nextStep: 'Siguiente paso',
    stepsAllDone: '¡Pasos de esta ronda completados! ✓',
    nextStepWithHint: 'Siguiente paso «{label}»: {hint}',
    nextStepNoHint: 'Siguiente paso «{label}»',

    maskTitle: 'Activa la cámara para entrenar',
    maskText: 'Todo el reconocimiento se hace en tu propio navegador: la imagen no se sube a ningún servidor.',
    maskHint: 'Consejo: móvil en horizontal o cámara del ordenador, a 2-3 m de distancia; en la sentadilla, de frente a la cámara, y en el resto de ejercicios, de perfil.',
    maskOpening: 'Abriendo la cámara…',
    maskOpeningText: 'Elige “Permitir” en la ventana del navegador. Si no pasa nada, pulsa el botón de abajo para reintentar.',
    maskCamFailTitle: 'No se pudo abrir la cámara',
    maskCamFailSuffix: '. Revisa los permisos del navegador y comprueba que ninguna otra aplicación esté usando la cámara.',
    maskModelLoading: 'Cargando el modelo de postura…',
    maskModelText: 'La primera carga tarda unos segundos (el modelo es local, no hace falta internet).',
    maskModelFail: 'No se pudo cargar el modelo de postura',
    maskUnsupportedTitle: 'Este navegador no admite la cámara',
    maskUnsupportedText: 'Usa la última versión de Chrome / Edge / Safari y abre esta página por http(s).',
    unknownError: 'Error desconocido',
  },

  /* ---------------- Calibración previa al entrenamiento ---------------- */
  calib: {
    title: 'Calibración previa',
    lead: 'Entra en el contorno punteado con todo el cuerpo dentro del encuadre',
    waiting: 'Esperando la calibración…',
    needCalib: 'Entra primero en el contorno punteado y completa la calibración antes de pulsar «Empezar»',
    doneVoice: 'Descansa y pulsa Empezar para otra serie',
    startNow: '¿Descansado? Pulsa «Empezar» (o espacio) para otra serie',
    recalibrate: 'Volver a calibrar',
    ready: 'Estás en una buena posición, no te muevas…',
    adjust: 'Entra en el contorno punteado',
    promptIn: 'Entra en el contorno punteado con todo el cuerpo',
    promptSearch: 'No te encuentro: ajusta tu posición para que todo el cuerpo quede dentro del contorno punteado',
    promptReady: 'Estás bien colocado, no te muevas…',
    visible: 'No veo bien todo tu cuerpo: ajusta tu posición para que se vean la cabeza y los pies',
    headCut: 'Se te corta la cabeza: retrocede un poco',
    feetCut: 'Se te cortan los pies: retrocede un poco',
    cutOff: 'Tu cuerpo se sale del encuadre: retrocede un poco o desplaza todo el cuerpo hacia el centro',
    lieCutOff: 'Un extremo del cuerpo se sale del encuadre: retrocede un poco o desplázate hacia dentro (no hace falta estar justo en el centro)',
    tooFar: 'Estás demasiado lejos de la cámara: acércate un poco para encajar en el contorno punteado',
    tooClose: 'Estás demasiado cerca de la cámara: aléjate un poco para encajar en el contorno punteado',
    centerLeft: 'Muévete un poco a la izquierda para quedar en el centro del contorno',
    centerRight: 'Muévete un poco a la derecha para quedar en el centro del contorno',
    moveUp: 'Desplázate un poco más arriba en el encuadre (ahora estás demasiado abajo)',
    moveDown: 'Desplázate un poco más abajo en el encuadre (ahora estás demasiado arriba)',
    viewFront: 'Ponte de frente a la cámara: en la sentadilla hay que grabar de frente para medir bien la profundidad',
    viewSide: 'Ponte de perfil a la cámara: en este ejercicio hay que grabar de lado para medir bien los ángulos',
    steady: 'Muy bien, no te muevas…',
    check: {
      visible: 'Cuerpo detectado',
      framing: 'Cuerpo entero visible',
      distance: 'Distancia correcta',
      center: 'Bien centrado',
      vertical: 'Altura correcta',
      view: 'Ángulo correcto',
      steady: 'Sin moverte',
    },
  },

  /* ---------------- Barra de estado / avisos ---------------- */
  status: {
    noPerson: 'No veo a nadie: colócate en el centro del encuadre con la cabeza y los pies visibles (da 1-2 pasos atrás)',
    noDetector: 'Detector no listo: pulsa otra vez el botón',
    noSound: 'Sin sonido: ① mira si la pestaña está silenciada (altavoz) ② el volumen no es 0 ③ voz del sistema instalada',
    ready: '¡Te veo! ✓ Mantén esta posición y haz el ejercicio',
    needCamera: 'Activa primero la cámara',
    countdownGo: '¡Vamos! Sigue las indicaciones; las repeticiones parciales no cuentan.',
    paused: 'En pausa. Pulsa “Continuar” para seguir entrenando.',
    resume: '¡Seguimos!',
    setDone: 'Serie terminada. Descansa un poco o empieza otra serie.',
    reset: 'Conteo y puntos reiniciados.',
    strictOn: 'Modo estricto: las repeticiones parciales no cuentan como válidas.',
    strictOff: 'Modo flexible: las repeticiones parciales también cuentan.',
    skeletonOn: 'Esqueleto visible.',
    skeletonOff: 'Esqueleto oculto; solo se ve la imagen de la cámara.',
    musicOn: 'Música de fondo alegre activada.',
    musicOff: 'Música de fondo desactivada.',
    musicTrack: 'Música de fondo cambiada a «{name}»',
    modelReady: 'Modelo listo. Elige el ejercicio, entra en el contorno punteado para completar la calibración y empieza a entrenar.',
    modelSwitched: 'Modelo «{model}» activado.',
    modelSwitchFail: 'No se pudo cambiar de modelo: {msg}',
    fileProtocol: 'Has abierto la página con file://: el navegador bloqueará el modelo y la cámara. Ábrela con node preview-server.js en http://127.0.0.1.',
    half: '¡Ya vas por la mitad, sigue así!',
    halfVoice: 'Vas por la mitad, sigue así',
    milestone: '¡Ya llevas {score} puntos!',
    goalVoice: 'Objetivo cumplido, ¡increíble!',
    cameraReady: 'Cámara {w}×{h}',
    cameraOff: 'Cámara desactivada',
    modelLoading: 'Cargando el modelo…',
    modelReadyShort: 'Modelo listo {model}/{delegate}',
    searching: 'Buscando a alguien… (colócate en el encuadre)',
    personFound: 'Cuerpo detectado ✓',
    notSupine: 'El puente de glúteos se hace tumbado: primero boca arriba con las rodillas flexionadas',
    holdPaused: 'El cronómetro seguirá solo cuando corrijas la postura',
    standbyPushup: 'Ponte en el suelo: manos bajo los hombros, cuerpo en línea recta y de perfil a la cámara',
    standbyBridge: 'Túmbate en la esterilla: rodillas flexionadas, pies bien apoyados y de perfil a la cámara',
    standbyPlank: 'Apóyate en el suelo con los antebrazos o las manos y alinea el cuerpo',
    standbyBridgeHold: 'Túmbate boca arriba con las rodillas flexionadas y los pies bien apoyados, de perfil a la cámara',
    lostTracking: 'No veo tu cuerpo entero: retrocede un poco para que salgas completo en el encuadre',
    need: {
      stand: 'Colócate en el encuadre y ponte bien de pie',
      prone: 'Ponte boca abajo: manos bajo los hombros y cuerpo en línea',
      supine: 'Túmbate en la esterilla: boca arriba y rodillas flexionadas',
      quadruped: 'A cuatro patas: manos y rodillas apoyadas en el suelo',
      kneel: 'De rodillas: apoya las rodillas y sube el torso',
      seated: 'Siéntate en la esterilla y colócate bien',
      side: 'Túmbate de lado hacia la cámara, apoyado en el antebrazo',
      inverted: 'Haz el pino contra la pared: cuerpo vertical y cadera por encima de los hombros',
      hang: 'Cuélgate de la barra con las dos manos y los pies en el aire',
    },
  },

  /* ---------------- Fases ---------------- */
  phase: {
    idle: 'Listo',
    up: 'Arriba',
    down: 'Abajo',
    descending: 'Bajando',
    bottom: 'Punto bajo',
    holding: 'Aguantando',
    paused: 'En pausa',
  },

  /* ---------------- Resumen final ---------------- */
  summary: {
    goalReached: '🎉 ¡Objetivo cumplido y serie guardada! Has hecho {score} puntos.',
    savedWithMiss: 'Has hecho {score} puntos. Para la próxima: {list}',
    savedAll: 'Has hecho {score} puntos. ¡Todos los pasos completados!',
    noData: 'Esta serie no ha registrado datos válidos. ¡Inténtalo otra vez!',
    celebrate: '🎉 Objetivo cumplido: {value}',
    celebrateReps: '{n} repeticiones',
    celebrateHold: '{n} segundos',
  },

  /* ---------------- Panel de diagnóstico ---------------- */
  debug: {
    noPerson: 'Métricas: no se detecta cuerpo',
    view: 'Vista',
    viewSide: 'Lateral',
    viewFront: 'Frontal',
    bodyVisible: 'Cuerpo entero',
    legsVisible: 'Piernas visibles',
    trunkLean: 'Inclinación del torso',
    knee: 'Rodilla',
    elbow: 'Codo',
    hip: 'Cadera',
    bodyStraight: 'Cuerpo en línea',
    hipRise: 'Elevación de cadera',
    thighFromHoriz: 'Muslo respecto a la horizontal',
    visibility: 'Visibilidad',
    sound: 'Sonido',
    state: 'Estado',
    yes: '✓',
    no: '✗',
    count: 'Diagnóstico de conteo',
    diag: {
      stage: 'Fase',
      steps: 'Pasos',
      counts: 'Válidas/parciales',
      backLine: 'Línea de retorno',
      repMin: 'Mínimo de esta rep',
      topBase: 'Tope medido',
      standLine: 'Línea de pie',
      startValue: 'Inicio (tuyo/ref)',
      peak: 'Pico de esta rep',
      hold: 'Cronometrado',
      pose: 'Postura',
      reject: 'Última no contada',
    },
  },

  /* ---------------- Datos de los ejercicios ---------------- */
  ex: {
    squat: {
      name: 'Sentadilla con peso corporal',
      cameraHint: 'De frente a la cámara y con el cuerpo entero en el encuadre (en la sentadilla hay que grabar de frente para medir bien la profundidad)',
      goal: 'Baja hasta que el muslo quede paralelo al suelo o más abajo',
      howto: ['Ponte de pie con los pies a la anchura de los hombros y de frente a la cámara', 'Flexiona las rodillas y baja la cadera hacia abajo, con las rodillas siguiendo la dirección de los pies', 'Baja hasta que el muslo quede paralelo al suelo o más abajo', 'Empuja con los pies para subir: cuenta cuando cadera y rodillas estén del todo extendidas'],
      tips: ['Mantén todo el pie apoyado, sin levantar los talones', 'No dejes que las rodillas se metan hacia dentro', 'No tires de la zona lumbar al subir'],
    },
    lunge: {
      name: 'Zancada al frente',
      cameraHint: 'De perfil a la cámara, con un pie delante y otro detrás',
      goal: 'Las dos rodillas cerca de 90° y la de atrás cerca del suelo',
      howto: ['Da un paso largo hacia delante con una pierna', 'Flexiona las dos rodillas a la vez y baja, con la de delante a unos 90°', 'Baja la rodilla de atrás hasta casi tocar el suelo', 'Empuja con el pie de delante para volver de pie y alterna las piernas'],
      tips: ['La rodilla de delante no debe pasar mucho la punta del pie', 'Mantén el torso recto', 'Haz zancadas alternas: una pierna y luego la otra'],
    },
    pushup: {
      name: 'Flexión',
      cameraHint: 'De perfil a la cámara, tumbado en el suelo o sobre una esterilla',
      goal: 'Codos flexionados por debajo de 90° y pecho cerca del suelo',
      howto: ['Apoya las manos algo más anchas que los hombros y alinea el cuerpo en línea recta', 'Activa el core y baja flexionando los codos', 'Baja hasta que el codo pase de 90° y el pecho quede cerca del suelo', 'Empuja para volver arriba: cuenta cuando los brazos estén del todo estirados'],
      tips: ['Mantén el cuerpo siempre en línea recta', 'No hundas la lumbar ni levantes el trasero', 'Las muñecas, justo debajo de los hombros'],
    },
    bridge: {
      name: 'Puente de glúteos',
      cameraHint: 'De perfil a la cámara, tumbado boca arriba con las rodillas flexionadas y los pies apoyados',
      goal: 'Sube la cadera hasta que hombro, cadera y rodilla queden casi en línea',
      howto: ['Túmbate boca arriba con las rodillas flexionadas y los pies a la anchura de la cadera', 'Aprieta los glúteos y sube la cadera', 'Sube hasta que hombro, cadera y rodilla queden casi en línea recta', 'Baja el glúteo al suelo con control: eso cuenta como una repetición'],
      tips: ['Empuja con los glúteos, no con la lumbar', 'Aguanta 1 segundo arriba notando el glúteo apretado', 'Mentón ligeramente recogido y omóplatos apoyados en el suelo'],
    },
    plank: {
      name: 'Plancha',
      cameraHint: 'De perfil a la cámara, apoyado en los antebrazos o en las manos',
      goal: 'Mantén el cuerpo en línea recta y aguanta',
      howto: ['Apoya los antebrazos justo debajo de los hombros (o con los brazos estirados)', 'Activa el core: cabeza, espalda, cadera y tobillos en línea', 'Respira de forma constante y aguanta', 'Si la postura se hunde, el cronómetro se pausa solo'],
      tips: ['No subas ni hundas la cadera', 'Empuja los omóplatos lejos del suelo', 'Si no aguantas, para: no fuerces la lumbar'],
    },
    pushupWide: {
      name: 'Flexiones abiertas',
      cameraHint: 'De perfil a la cámara, con las manos más anchas que los hombros',
      goal: 'Manos más anchas que los hombros y codos por debajo de 90°',
    },
    pushupDiamond: {
      name: 'Flexiones diamante',
      cameraHint: 'De perfil a la cámara, con las manos juntas en rombo bajo el pecho',
      goal: 'Manos en rombo y codos pegados al cuerpo al bajar',
    },
    squatSumo: {
      name: 'Sentadilla sumo',
      cameraHint: 'De frente a la cámara, con los pies a 1,5 veces la anchura de los hombros y las punteras hacia fuera',
      goal: 'Piernas abiertas y cadera abajo hasta que el muslo quede casi horizontal',
    },
    bulgarianSplitSquat: {
      name: 'Sentadilla búlgara',
      cameraHint: 'De perfil a la cámara, con el pie de atrás en una silla o un escalón',
      goal: 'Pie de atrás elevado y baja con la pierna de delante a unos 90°',
    },
    lungeBack: {
      name: 'Zancada atrás',
      cameraHint: 'De perfil a la cámara, con un pie delante y otro detrás',
      goal: 'Da un paso largo hacia atrás y baja flexionando las dos rodillas',
    },
    lungeJump: {
      name: 'Zancada con salto',
      cameraHint: 'De perfil a la cámara y con espacio delante y detrás',
      goal: 'Baja en zancada y salta despegando los dos pies',
    },
    squatJump: {
      name: 'Sentadilla con salto',
      cameraHint: 'De frente a la cámara y con espacio por arriba',
      goal: 'Baja del todo y salta con fuerza despegando los pies',
    },
    sidePlank: {
      name: 'Plancha lateral',
      cameraHint: 'De perfil a la cámara, de lado y apoyado en un antebrazo',
      goal: 'Sube la cadera y mantén el cuerpo en línea de la cabeza a los pies',
    },
    crunch: {
      name: 'Encogimientos',
      cameraHint: 'De perfil a la cámara, boca arriba con las rodillas flexionadas y los pies apoyados',
      goal: 'Despega los omóplatos del suelo con el abdomen y baja despacio',
    },
    reverseCrunch: {
      name: 'Encogimientos inversos',
      cameraHint: 'De perfil a la cámara, boca arriba con las rodillas flexionadas',
      goal: 'Lleva las rodillas al pecho y despega un poco la cadera',
    },
    lyingLegRaise: {
      name: 'Elevación de piernas tumbado',
      cameraHint: 'De perfil a la cámara, boca arriba con las piernas estiradas',
      goal: 'Sube las piernas juntas casi a la vertical y bájalas con control',
    },
    mountainClimber: {
      name: 'Escaladores',
      cameraHint: 'De perfil a la cámara, con los brazos estirados apoyados en el suelo',
      goal: 'Lleva las rodillas al pecho rápido, alternando',
    },
    deadBug: {
      name: 'Bicho muerto',
      cameraHint: 'De perfil a la cámara, boca arriba con brazos y piernas levantados',
      goal: 'Estira a la vez brazo y pierna contrarios, alternando los lados',
    },
    burpee: {
      name: 'Burpee',
      cameraHint: 'De frente a la cámara y con espacio delante y por arriba',
      goal: 'Sentadilla, plancha, recoge las piernas, levántate y salta',
    },
    boxJump: {
      name: 'Salto al cajón',
      cameraHint: 'De frente a la cámara, con un cajón firme delante',
      goal: 'Flexiona las rodillas y salta al cajón; baja cuando estés estable',
    },
    standingForwardFold: {
      name: 'Flexión de pie',
      cameraHint: 'De perfil a la cámara, con los pies juntos o a la anchura de la cadera',
      goal: 'Rodillas algo flexionadas y pliega el torso hacia abajo desde la cadera',
    },
    seatedForwardFold: {
      name: 'Flexión sentado',
      cameraHint: 'De perfil a la cámara, sentado con las piernas estiradas',
      goal: 'Pliega el torso desde la cadera y lleva las manos hacia los pies',
    },
  },

  /* ---------------- Pasos de la técnica ---------------- */
  steps: {
    squat: {
      stance: {
        label: 'Colócate de frente a la cámara, recto y con el cuerpo entero en el encuadre',
        view: 'Te veo de perfil: ponte de frente a la cámara (en la sentadilla hay que grabar de frente para medir bien la profundidad)',
        body: 'No veo tu cuerpo entero: retrocede un poco para que salgan la cabeza y los pies',
        lean: 'Estás algo torcido: ponte recto y mantén la simetría entre izquierda y derecha',
        knee: 'Estira del todo las dos piernas',
        tune: 'Endereza un poco más y te llevas este paso',
      },
      hinge: { label: 'Flexiona las rodillas y baja la cadera', hint: 'Empieza a bajar: flexiona las rodillas y lleva la cadera hacia abajo' },
      descend: { label: 'Flexiona las rodillas siguiendo la dirección de los pies y baja', hint: 'Sigue bajando y flexiona más las rodillas' },
      parallel: { label: 'Baja hasta que el muslo quede casi horizontal (el paso que más puntúa)', hint: 'Baja un poco más: ahora estás al {pct}% (100% = muslo horizontal)' },
      stand: { label: 'Empuja con los pies y sube con cadera y rodillas del todo extendidas', hint: 'Empuja el suelo con los pies y estira la cadera y las rodillas' },
    },
    lunge: {
      stance: {
        label: 'Colócate de perfil a la cámara, recto y con el cuerpo entero en el encuadre',
        view: 'Te veo de frente o en diagonal: ponte de perfil a la cámara (cuerpo perpendicular), solo así se miden bien los ángulos',
        body: 'No veo tu cuerpo entero: retrocede un poco para que salgan la cabeza y los pies',
        lean: 'Estás algo torcido o inclinado: ponte recto, con los hombros justo encima de la cadera',
        knee: 'Estira del todo las dos piernas',
        tune: 'Endereza un poco más y te llevas este paso',
      },
      split: { label: 'Da un paso hacia delante y separa los pies', hint: 'Da un paso: ahora la separación entre los pies es de solo un {pct}% (necesitas más del 45%)' },
      stride: { label: 'Da un paso bien largo (más distancia entre los pies)', hint: 'Abre más el paso: alarga la distancia entre el pie de delante y el de atrás' },
      sink: { label: 'Flexiona las dos rodillas a la vez y baja; la de delante, a unos 90°', hint: 'Baja flexionando las dos rodillas, con la de delante cerca de 90°' },
      backknee: { label: 'Baja la rodilla de atrás hasta casi el suelo (el paso que más puntúa)', hint: 'Baja más la pierna de atrás hasta que la rodilla casi toque el suelo' },
      return: { label: 'Empuja con el pie de delante y vuelve de pie', hint: 'Empuja con el pie de delante y recupera la postura erguida' },
    },
    pushup: {
      setup: {
        label: 'Apoya las manos en el suelo con el cuerpo en línea recta',
        pose: 'Primero ponte boca abajo: manos bajo los hombros y cuerpo alineado',
        hands: 'Las palmas tienen que apoyarse en el suelo',
        straight: 'El cuerpo debe quedar en línea recta: mete tripa y aprieta glúteos; ni lumbar hundida ni trasero alto',
        tune: 'Alinea el cuerpo en una línea recta y sumas el paso',
      },
      lower: { label: 'Activa el core y baja flexionando los codos', hint: 'Empieza a bajar: flexiona los codos y acerca el pecho al suelo' },
      depth: { label: 'Flexiona los codos por debajo de 90° y acerca el pecho al suelo (el paso que más puntúa)', hint: 'Baja un poco más: ahora el codo está a unos {deg}°' },
      press: { label: 'Empuja hacia arriba hasta estirar los brazos del todo', hint: 'Empuja con fuerza y estira los brazos del todo' },
    },
    bridge: {
      setup: {
        label: 'Túmbate boca arriba con las rodillas flexionadas y los pies apoyados a la anchura de la cadera',
        pose: 'Primero túmbate: boca arriba en la esterilla, rodillas flexionadas y pies bien apoyados',
        knee: 'Flexiona las rodillas (unos 90°) y apoya bien los pies en el suelo',
        lift: 'Flexiona las rodillas y apoya las plantas en el suelo',
        tune: 'Túmbate con las rodillas flexionadas y sumas este paso',
      },
      lift: { label: 'Aprieta los glúteos y sube la cadera', hint: 'Aprieta los glúteos y sube la cadera' },
      top: { label: 'Sube hasta que hombro, cadera y rodilla queden casi en línea (el paso que más puntúa)', hint: 'Sigue subiendo hasta que hombro, cadera y rodilla queden casi en línea recta' },
      lower: { label: 'Baja el glúteo al suelo con control', hint: 'Baja el glúteo al suelo con control (sin dejarlo caer de golpe)' },
    },
    plank: {
      setup: {
        label: 'Apoya los antebrazos bajo los hombros y levanta el cuerpo',
        pose: 'Primero apóyate en el suelo: antebrazos justo debajo de los hombros y cuerpo alineado',
        lift: 'Levanta el cuerpo, no te quedes tumbado',
        hands: 'Las palmas o los antebrazos tienen que tocar el suelo',
        elbow: 'Antebrazos bien firmes en el suelo (codo a unos 90°) o brazos del todo estirados',
      },
      align: {
        label: 'Cabeza, espalda, cadera y tobillos en línea recta',
        sag: 'Se te hunde la lumbar: aprieta los glúteos y mete tripa',
        pike: 'Tienes el glúteo demasiado alto: bájalo y alinea el cuerpo',
        tune: 'Activa el core y alinea hombros, cadera y tobillos',
      },
      hold3: { label: 'Aguanta 3 segundos sin moverte' },
      hold10: { label: 'Aguanta 10 segundos sin moverte' },
      hold30: { label: 'Aguanta 30 segundos sin moverte' },
    },
    repStand: {
      stance: {
        label: 'Colócate en la posición inicial con los pies bien apoyados',
        hint: 'Primero colócate: piernas casi estiradas y el peso estable',
      },
      lower: {
        label: 'Flexiona las rodillas y baja siguiendo la técnica',
        hint: 'Empieza a bajar: cadera atrás y abajo, rodillas hacia la punta de los pies',
      },
      bottom: {
        label: 'Llega a la amplitud objetivo (el paso que más puntúa)',
        hint: 'Baja un poco más y completa el recorrido',
      },
      up: {
        label: 'Empuja con los pies y vuelve a la posición inicial',
        hint: 'Vuelve al inicio para que cuente la repetición',
      },
    },
    repProne: {
      setup: {
        label: 'Colócate en apoyo con el cuerpo en línea de la cabeza a los pies',
        pose: 'Primero apóyate: manos bajo los hombros y cuerpo alineado',
        hint: 'Aprieta el cuerpo en una línea: ni lumbar hundida ni trasero alto',
      },
      lower: {
        label: 'Baja el cuerpo flexionando los codos',
        hint: 'Baja despacio flexionando los codos',
      },
      bottom: {
        label: 'Baja hasta la profundidad objetivo (el paso que más puntúa)',
        hint: 'Baja un poco más, con el pecho cerca del suelo',
      },
      press: {
        label: 'Empuja hacia arriba hasta estirar los brazos',
        hint: 'Empuja para subir y estira los brazos',
      },
    },
    repSupine: {
      setup: {
        label: 'Túmbate y colócate en la posición inicial',
        hint: 'Primero túmbate boca arriba y colócate bien',
      },
      engage: {
        label: 'Activa el abdomen y empieza a subir',
        hint: 'Empieza a subir con la fuerza del abdomen',
      },
      top: {
        label: 'Sube hasta la posición objetivo (el paso que más puntúa)',
        hint: 'Sube un poco más y llega al objetivo',
      },
      lower: {
        label: 'Baja con control, despacio',
        hint: 'Baja despacio, sin dejarte caer',
      },
    },
    repAlt: {
      setup: {
        label: 'Colócate en la posición de apoyo y mantente estable',
        hint: 'Primero colócate bien y luego empieza a alternar',
      },
      first: {
        label: 'Haz el primer movimiento',
        hint: 'Empieza: un lado se mueve y el otro se queda quieto',
      },
      switch: {
        label: 'Cambia de lado y alterna',
        hint: 'Cambia al otro lado y sigue',
      },
      rhythm: {
        label: 'Mantén el ritmo alternando',
        hint: 'Mantén el ritmo y haz varias por lado',
      },
    },
    sequence: {
      setup: {
        label: 'Colócate de pie y prepárate para la secuencia',
        hint: 'Primero ponte de pie y prepárate',
      },
      down: {
        label: 'Baja y apoya las manos en el suelo',
        hint: 'Haz la sentadilla y pon las manos en el suelo',
      },
      middle: {
        label: 'Completa la parte central',
        hint: 'Alinea el cuerpo en una línea recta',
      },
      finish: {
        label: 'Levántate y termina la secuencia',
        hint: 'Recoge las piernas, levántate y termina',
      },
    },
    jump: {
      stance: {
        label: 'Colócate de pie, listo para saltar',
        hint: 'Primero ponte de pie con los pies bien apoyados',
      },
      crouch: {
        label: 'Flexiona las rodillas y lleva los brazos atrás',
        hint: 'Baja flexionando las rodillas y lleva los brazos atrás',
      },
      flight: {
        label: 'Salta con fuerza despegando los pies (el paso que más puntúa)',
        hint: 'Salta con fuerza y despega los dos pies',
      },
      land: {
        label: 'Cae flexionando las rodillas y quédate estable',
        hint: 'Cae con las rodillas flexionadas y estabilízate antes de repetir',
      },
    },
    holdPose: {
      pose: {
        label: 'Colócate en la postura correcta',
        hint: 'Colócate bien y luego pon en marcha el cronómetro',
      },
      align: {
        label: 'Cuerpo en línea y sin moverte',
        hint: 'Aprieta el cuerpo en una línea y no te balancees',
      },
      hold3: {
        label: 'Aguanta 3 segundos',
      },
      hold10: {
        label: 'Aguanta 10 segundos',
      },
      hold30: {
        label: 'Aguanta 30 segundos',
      },
    },
    stretchHold: {
      pose: {
        label: 'Entra despacio en la postura de estiramiento',
        hint: 'Entra poco a poco, sin rebotes',
      },
      settle: {
        label: 'Respira y siente el estiramiento',
        hint: 'Respira tranquilo: basta con notar un tirón suave',
      },
      hold10: {
        label: 'Mantén 10 segundos',
      },
      hold20: {
        label: 'Mantén 20 segundos',
      },
    },
  },

  /* ---------------- Categorías de ejercicios ---------------- */
  cat: {
    title: 'Categorías de ejercicios',
    upper: 'Tren superior',
    lower: 'Tren inferior',
    core: 'Core',
    full: 'Cuerpo completo',
    stretch: 'Estiramientos',
  },

  /* ---------------- Biblioteca de ejercicios ---------------- */
  home: {
    title: 'Elige ejercicio',
    subtitle: 'Elige un ejercicio por categoría y entra: la cámara te reconoce en tiempo real y te guía por voz',
    count: '{n} ejercicios',
    search: 'Buscar ejercicio',
    noResult: 'No hay ejercicios que coincidan',
    back: 'Volver al inicio',
    openSettings: 'Ajustes',
    rough: 'Estimación aproximada',
    judgeBy: 'Se mide por: {what}',
    start: 'Entrar a entrenar',
    recent: 'Últimos entrenados',
  },

  /* ---------------- Ajustes ---------------- */
  settings: {
    title: 'Ajustes',
    close: 'Cerrar',
    language: 'Idioma',
    model: 'Modelo de detección',
    modelHint: 'El ligero va más fluido y el completo es más preciso (el primer cambio descarga unas decenas de MB; después funciona sin conexión)',
    sound: 'Sonido',
    musicTrack: '🎵 Pista de fondo',
    cameraGroup: 'Imagen y detección',
    view: 'Interfaz',
  },

  /* ---------------- Criterios de medición ---------------- */
  judge: {
    elbow: 'Flexión de codo',
    knee: 'Flexión de rodilla',
    hip: 'Plegado de cadera',
    ankle: 'Subida y bajada del tobillo',
    rise: 'Altura de la cadera',
    clear: 'Altura del cuerpo respecto al suelo',
    flight: 'Pies en el aire (salto)',
    twist: 'Giro del torso a cada lado',
    sequence: 'Orden de la secuencia',
    arm: 'Elevación de un brazo',
    leg: 'Alternancia de piernas',
    pose: 'Corrección de la postura',
    time: 'Tiempo aguantando la postura',
  },

  /* ---------------- Avisos generales (cue) ---------------- */
  cue: {
    depth: 'Un poco más de recorrido: baja algo más',
    tempo: 'Más despacio, sigue el ritmo',
    notReady: 'Todavía no estás en la postura del ejercicio: colócate como te indico',
    moreRange: 'Haz más recorrido: el movimiento completo cuenta como repetición',
    needJump: 'Hay que saltar: cuenta cuando los pies despeguen del suelo',
    tooFast: 'Más despacio, vas muy rápido',
    keepStraight: 'Mantén el cuerpo en línea recta, sin hundir la lumbar ni subir el trasero',
    sag: 'Se te hunde la lumbar: mete tripa y sube la cadera a la línea del cuerpo',
    pike: 'Tienes el glúteo demasiado alto: aplana la pelvis y alinea el cuerpo',
    valgus: 'No metas las rodillas hacia dentro: ábrelas hacia la punta de los pies',
    lean: 'Mantén el torso recto, sin inclinarte ni ladearte',
    pose: 'La postura se ha desviado: corrígela y sigue',
  },

  /* ---------------- Técnica por familia de ejercicios ---------------- */
  fam: {
    repStand: {
      howto: ['Ponte de pie con los pies bien apoyados', 'Lleva la cadera atrás y abajo, con las rodillas siguiendo la dirección de los pies', 'Llega a la amplitud objetivo y sube estirándote del todo'],
      tips: ['No dejes que las rodillas se metan hacia dentro', 'Mantén la espalda recta, sin doblarla', 'Reparte el peso por todo el pie'],
    },
    repProne: {
      howto: ['Apoya las manos bajo los hombros y alinea el cuerpo de la cabeza a los pies', 'Activa el core y baja despacio flexionando los codos', 'Empuja para subir: cuenta cuando los brazos estén estirados'],
      tips: ['Ni lumbar hundida ni trasero alto', 'Las muñecas, justo debajo de los hombros', 'Baja despacio y sube con fuerza'],
    },
    repSupine: {
      howto: ['Túmbate boca arriba en la esterilla y colócate en la posición inicial', 'Activa el abdomen y sube el cuerpo o las piernas hasta el objetivo', 'Baja con control hasta la posición inicial'],
      tips: ['Mentón ligeramente recogido: no tires del cuello', 'Trabaja con el abdomen todo el rato, sin aguantar la respiración', 'Baja controlando, sin dejarte caer'],
    },
    repAlt: {
      howto: ['Colócate en la posición de apoyo, con el core activo y el cuerpo estable', 'Mueve un lado mientras el otro se queda quieto', 'Alterna izquierda y derecha con un ritmo constante'],
      tips: ['No balancees la cadera de un lado a otro', 'Despacio funciona mejor que rápido', 'Si notas molestias en la lumbar, para'],
    },
    sequence: {
      howto: ['Ponte de pie y baja apoyando las manos en el suelo', 'Salta con los pies atrás hasta la plancha (puedes añadir una flexión)', 'Recoge las piernas, levántate y termina con un salto'],
      tips: ['Cae flexionando las rodillas para amortiguar', 'Si te cansas, puedes saltarte la flexión', 'La secuencia solo cuenta si la haces seguida'],
    },
    jump: {
      howto: ['Ponte de pie, flexiona las rodillas y lleva los brazos atrás', 'Salta con fuerza despegando los dos pies', 'Cae flexionando las rodillas y estabilízate antes de repetir'],
      tips: ['Cae suave, sin bloquear las rodillas', 'No pasa nada si no saltas alto: basta con despegar', 'Hazlo en una superficie blanda o sobre una esterilla'],
    },
    holdPose: {
      howto: ['Colócate en la postura correcta', 'Activa el core y mantén el cuerpo en línea o bien estable', 'Respira de forma constante hasta el tiempo objetivo'],
      tips: ['Si la postura se hunde, el cronómetro se pausa solo: corrígete y sigue', 'Si te cuesta, empieza con un tiempo objetivo más corto', 'Si notas dolor en la lumbar, para enseguida'],
    },
    stretchHold: {
      howto: ['Entra despacio en la postura de estiramiento, sin rebotes', 'Con notar un tirón suave es suficiente, no busques el dolor', 'Respira y mantén entre 20 y 30 segundos'],
      tips: ['Calienta las articulaciones antes de estirar', 'Estira los dos lados, el mismo tiempo en cada uno', 'No aguantes la respiración: espira despacio y te relajarás más'],
    },
  },

  /* ---------------- Correcciones en directo (cues) ---------------- */
  /* ---------------- 背景音乐曲目 ---------------- */
  music: {
    track: {
      cityRun: 'Carrera urbana',
      neonPulse: 'Pulso de neón',
      sunriseFunk: 'Funk del amanecer',
      powerDrive: 'Impulso total',
    },
  },

  cues: {
    squat: {
      valgus: 'No metas las rodillas hacia dentro: ábrelas hacia la punta de los pies',
      lateral: 'No te ladees: mantén la simetría entre izquierda y derecha, con los hombros justo encima de la cadera',
      depth: 'Baja un poco más, hasta que el muslo quede casi horizontal',
      depthAborted: 'Baja más: las repeticiones parciales no cuentan',
      halfway: 'Baja hasta que el muslo quede paralelo al suelo y luego sube',
      tempo: 'Vas muy rápido: baja despacio, haz una pausa y sube',
    },
    lunge: {
      backknee: 'Baja más la rodilla de atrás, hasta casi el suelo',
      lean: 'Mantén el torso recto, sin inclinarte hacia delante',
      lungeDepth: 'Baja más: rodilla de delante a unos 90° y la de atrás cerca del suelo',
      tempo: 'Más despacio: controla la bajada y la subida',
      alternate: 'Cambia de pierna: alterna izquierda y derecha',
    },
    pushup: {
      sag: 'Se te hunde el glúteo: apriétalo y activa el core',
      pike: 'Tienes el glúteo demasiado alto: alinea el cuerpo en una línea recta',
      body: 'Esta repetición no ha salido en línea: activa el core y hazla otra vez',
      depth: 'Baja un poco más, con los codos por debajo de 90°',
      tempo: 'Más despacio, controla la bajada',
    },
    bridge: {
      notSupine: 'El puente de glúteos se hace tumbado: primero boca arriba con las rodillas flexionadas',
      riseMore: 'Sube más el glúteo hasta que el muslo y el cuerpo queden en línea',
      tempo: 'Sube y baja despacio, sin usar el impulso',
    },
    plank: {
      lift: 'Levanta el cuerpo, no te quedes tumbado',
      pose: 'Apóyate en el suelo con los antebrazos o las manos y alinea el cuerpo',
      sag: 'Se te hunde la lumbar: aprieta los glúteos y mete tripa',
      pike: 'Tienes el glúteo demasiado alto: bájalo para quedar en línea',
      straight: 'El cuerpo debe quedar en línea recta: activa el core y aprieta los glúteos',
      hands: 'Las palmas o los antebrazos tienen que tocar el suelo',
      knees: 'Levanta las rodillas del suelo y apóyate en las puntas de los pies',
      elbow: 'Antebrazos bien firmes en el suelo (codo a unos 90°) o brazos del todo estirados',
    },
  },

  /* ---------------- Voz ---------------- */
  speech: {
    repSuffix: '',
    secondSuffix: 'segundos',
    scoreSuffix: 'puntos',
    start: 'Empezamos',
    half: 'Vas por la mitad, sigue así',
    voiceTest: 'Voz activada',
    goal: 'Objetivo cumplido, ¡increíble!',
    noPerson: 'Ponte en el centro de la imagen y que se te vea todo el cuerpo',
    nextStep: 'Siguiente: {label}. {hint}',
    nextStepNoHint: 'Siguiente: {label}',
    setSummary: 'Serie terminada: {value} {unit}, puntuación {score}',
  },
};
