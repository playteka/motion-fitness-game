# Fitness por movimiento · Motion Fitness Game

[中文](README.md) · [English](README.en.md) · [Español](README.es.md) · [Français](README.fr.md)

Un minijuego de fitness que reconoce tus movimientos con una cámara normal: **22 ejercicios** repartidos en cinco categorías — **tren superior / tren inferior / core / cuerpo completo / estiramientos** —;
en la página de inicio eliges el ejercicio por categoría y entras a entrenar directamente; **los de repeticiones cuentan solos y los de cronómetro cronometran solos**,
y además **puntúan paso a paso según «la técnica del ejercicio»**: cada paso que cumples suma puntos al instante, suena un aviso y la voz lo anuncia en alto.

La interfaz está disponible en **中文 / English / Español / Français**; puedes cambiar de idioma cuando quieras desde el **⚙️ Ajustes** de la esquina superior derecha (el idioma, el modelo de detección, los efectos de sonido y la música de fondo están todos ahí).

Es 100 % front-end: el modelo de postura de MediaPipe y el wasm están en la carpeta local `vendor/`, así que **no se conecta a internet y la imagen no se sube a ningún servidor**.

---

## Índice

- [Puntos destacados](#puntos-destacados)
- [Requisitos](#requisitos)
- [Instalación](#instalación)
  - [Paso 0: consigue el código](#paso-0-consigue-el-código)
  - [Paso 1: instala Node.js](#paso-1-instala-nodejs)
  - [Instalar Node.js en Windows](#instalar-nodejs-en-windows)
  - [Instalar Node.js en macOS](#instalar-nodejs-en-macos)
  - [Instalar Node.js en Linux](#instalar-nodejs-en-linux)
  - [Sin Node.js: también puedes usar Python](#sin-nodejs-también-puedes-usar-python)
- [Iniciar y acceder](#iniciar-y-acceder)
- [Permisos de cámara](#permisos-de-cámara)
- [Página de inicio y página del ejercicio](#página-de-inicio-y-página-del-ejercicio)
- [Ventana de ajustes (idioma / modelo / sonido)](#ventana-de-ajustes-idioma--modelo--sonido)
- [Calibración previa](#calibración-previa)
- [Cómo usarlo: la posición de la cámara es clave](#cómo-usarlo-la-posición-de-la-cámara-es-clave)
- [Catálogo de ejercicios (22 ejercicios)](#catálogo-de-ejercicios-22-ejercicios)
- [Reglas de puntuación](#reglas-de-puntuación)
- [Idiomas](#idiomas)
- [Si no entras en el contorno o no pasa nada: cuatro pasos de diagnóstico](#si-no-entras-en-el-contorno-o-no-pasa-nada-cuatro-pasos-de-diagnóstico)
- [Preguntas frecuentes](#preguntas-frecuentes)
- [Pruebas](#pruebas)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Añadir ejercicios / ajustar puntos / cambiar umbrales](#añadir-ejercicios--ajustar-puntos--cambiar-umbrales)
- [Privacidad y licencia](#privacidad-y-licencia)

---

## Puntos destacados

- **Página de inicio (cinco categorías)**: al entrar lo primero que ves es un muro de ejercicios por categorías — tren superior (3) · tren inferior (7) · core (6) · cuerpo completo (5) · estiramientos (2) —,
  cada ejercicio con su tarjeta (icono + nombre + repeticiones/cronómetro + objetivo + criterio de detección) y, arriba, un buscador. Pulsa una tarjeta para entrar en la página del ejercicio y con «Volver al inicio», arriba a la izquierda, vuelves cuando quieras.
  La «sentadilla con salto» aparece a la vez en dos categorías (al pulsarla es el mismo ejercicio).
- **Página del ejercicio + ventana de ajustes**: arriba a la derecha de la página del ejercicio está ⚙️ Ajustes, y la ventana reúne el **idioma, el modelo de detección, los efectos de sonido, la voz y la música de fondo**,
  además de los interruptores de espejo, modo estricto, esqueleto, ángulos y métricas — ya no tienes que buscar botones por toda la pantalla.
- **Calibración previa**: antes de empezar, en la imagen aparece una **silueta punteada del cuerpo** (solo el contorno exterior, sin alinear ningún esqueleto) y arriba aparece un texto que te indica
  «entra dentro del contorno punteado»; **basta con que se detecte el cuerpo y que todo el cuerpo esté dentro del encuadre para poder empezar** (unos 0,6 segundos), mientras que
  la distancia, el centrado, la altura, el ángulo y la quietud son solo recomendaciones (marcadas con «·» en el panel) y ya no bloquean el inicio.
- **Puntuación progresiva según la técnica**: cada ejercicio se divide en 4-6 pasos que se pueden evaluar; cada paso correcto suma puntos al instante, suena un aviso y se marca una casilla;
  si completas todos los pasos de la ronda, te llevas una bonificación de puntuación perfecta; en los ejercicios de cronómetro, **cada segundo aguantado suma +1 punto**.
- **Detección de repeticiones válidas (permisiva por defecto)**: **si haces el movimiento a grandes rasgos, cuenta** — las sentadillas y zancadas menos profundas, las flexiones que bajan solo una parte del recorrido y los puentes de glúteo que no suben mucho también cuentan, mientras la voz corrige «baja más / baja un poco más / sube más las caderas / no hundas la lumbar» y la puntuación se ajusta según la calidad; si quieres que «solo cuente si bajas hasta el fondo», activa el **modo estricto** en ⚙️ Ajustes. Lo que no has hecho de verdad (un simple balanceo) no se cuenta ni genera avisos insistentes.
- **Todos los ejercicios indican su «criterio de detección»**: la tarjeta y la página del ejercicio señalan por lo que se evalúa ese movimiento (flexión de codo / flexión de rodilla /
  altura de la cadera / pies en el aire / corrección de la postura …), y los que la cámara no puede medir con precisión se marcan además como **detección aproximada**.
- **Estado en tiempo real**: debajo de la imagen siempre ves «en qué estado estás, en qué paso te has quedado y cuántos grados te faltan».
- **🐞 Métricas**: muestra con un clic todos los números en bruto que ve el detector (vista, visibilidad, ángulos de cada articulación), así localizas de un vistazo cualquier problema de colocación.
- **Voz con conteo + sonidos**: cada paso cumplido suena con un aviso ascendente; la primera vez que lo cumples, la voz lo anuncia, y cada 50 puntos te canta la puntuación.
- **La voz ante todo**: si no te encuentra te llama, dice en voz alta qué paso del movimiento toca y cuánto te falta, y corrige al instante cuando la postura no es correcta,
  y los pasos cumplidos, el conteo, la puntuación y el resumen de la serie también se dicen en voz alta: casi no hace falta mirar la pantalla.
- **🎶 Cuatro pistas de fondo a elegir**: todas sintetizadas al vuelo (no ocupan espacio ni necesitan conexión): elige una en «🎵 Pista de fondo» dentro de los ajustes:
  **Carrera urbana** (132 BPM, ligera y con swing) / **Pulso de neón** (144 BPM, electrónica a cuatro tiempos) / **Funk del amanecer** (122 BPM, síncopa funk) / **Impulso total** (152 BPM, rock que empuja).
  La batería está de verdad sintetizada (bombo, caja, charles, palmas), así que el ritmo suena mucho más marcado, y la música se baja sola mientras la voz habla.
- **🦴 Esqueleto**: puedes ocultarlo y dejar solo la imagen de la cámara; las anotaciones de ángulos se activan por separado.
- **Anillo de progreso del objetivo, mejor marca e historial de entrenamientos** (se guardan en el navegador).
- **Funciona sin conexión**: el modelo y el wasm están en local, así que funciona sin internet; la imagen no se sube a ningún sitio.

---

## Requisitos

| Elemento | Requisito |
|---|---|
| Sistema operativo | Windows 10/11, macOS 11+ o cualquier distribución de escritorio de Linux habitual |
| Navegador | Chrome / Edge 91+, Safari 16.4+, Firefox 89+ (con compatibilidad con WebAssembly SIMD) |
| Cámara | Sirve la cámara integrada del portátil o una webcam USB; se recomienda 720p o más |
| Node.js | **Opcional**. El `preview-server.js` incluido necesita Node 18+; si no quieres instalar Node, también puedes usar Python |
| Conexión | **Solo hace falta para descargar el código**; el funcionamiento y el reconocimiento son totalmente offline |

---

## Instalación

### Paso 0: consigue el código

**Opción A: descargar el ZIP (la recomendada si no quieres pelearte con git)**

1. Abre <https://github.com/playteka/motion-fitness-game>
2. Pulsa el botón verde **Code** → **Download ZIP**
3. Descomprímelo en cualquier carpeta, por ejemplo `C:\Users\tu-usuario\motion-fitness-game` (Windows) o `~/motion-fitness-game` (macOS / Linux)

**Opción B: clonar con git**

```bash
git clone https://github.com/playteka/motion-fitness-game.git
cd motion-fitness-game
```

> El repositorio ya incluye el wasm de MediaPipe y el modelo de postura (unos 33 MB), así que **no hace falta** ejecutar ningún paso para instalar dependencias: aquí no hay `npm install`.

### Paso 1: instala Node.js

Node solo hace falta para ejecutar el pequeño servidor estático local que viene incluido (unas pocas líneas de código). **Si ya lo tienes instalado, sáltate este paso**; compruébalo con `node -v`:

```bash
node -v      # necesitas v18 o superior; v20 y v22 también valen
```

---

### Instalar Node.js en Windows

**Opción 1: winget (viene de serie en Windows 10 1809+ / Windows 11, la más cómoda)**

Abre **PowerShell** (busca "PowerShell" en el menú Inicio) y ejecuta:

```powershell
winget install OpenJS.NodeJS.LTS
```

**Opción 2: instalador oficial**

1. Abre <https://nodejs.org/> → descarga el **Windows Installer (.msi)** de la versión **LTS** (64-bit)
2. Haz doble clic y ve pulsando Next; **asegúrate de dejar marcada la casilla "Add to PATH", que viene activada por defecto**
3. Cuando termine la instalación, **cierra y vuelve a abrir** PowerShell o el símbolo del sistema

**Comprueba que funciona:**

```powershell
node -v
npm -v
```

Si los dos comandos muestran un número de versión (por ejemplo `v22.14.0` / `10.9.2`), ya está todo listo.

> Si te sale el aviso «no se reconoce "node" como nombre de cmdlet», es que el PATH no ha surtido efecto: cierra la terminal y ábrela de nuevo; si sigue igual, reinstala Node y confirma que dejaste marcada la casilla Add to PATH.

---

### Instalar Node.js en macOS

**Opción 1: Homebrew (la recomendada)**

Si todavía no tienes Homebrew, ejecuta primero en Terminal el comando que indica su web (<https://brew.sh>):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Y después:

```bash
brew install node
```

**Opción 2: instalador oficial**

1. Abre <https://nodejs.org/> → descarga el **macOS Installer (.pkg)** de la versión **LTS**
2. Haz doble clic y ve pulsando Continuar hasta terminar
3. Abre Terminal para comprobarlo

**Comprueba que funciona:**

```bash
node -v
npm -v
```

> El paquete universal de la web oficial sirve tanto para los chips de Apple (serie M) como para los Intel; Homebrew instala automáticamente la versión que corresponde a tu arquitectura.

---

### Instalar Node.js en Linux

**Debian / Ubuntu / Linux Mint**

La versión que traen los repositorios del sistema suele ser bastante antigua, así que se recomienda el repositorio LTS de NodeSource:

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

**Opción universal: nvm (funciona en cualquier distribución y no necesita sudo)**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# vuelve a abrir la terminal, o ejecuta antes: source ~/.bashrc
nvm install --lts
```

**Comprueba que funciona:**

```bash
node -v
npm -v
```

> **Permisos de cámara (solo en Linux)**: comprueba que el dispositivo existe y que tienes permisos de lectura y escritura
> ```bash
> ls -l /dev/video*
> ```
> Si el dispositivo pertenece a `root:video`, añádete al grupo video y **vuelve a iniciar sesión**:
> ```bash
> sudo usermod -aG video $USER
> ```
> Con `http://127.0.0.1` el navegador puede usar la cámara sin problema (localhost se considera un contexto seguro), no hace falta configurar nada más.

---

### Sin Node.js: también puedes usar Python

En esencia, este proyecto es una **página web estática**, así que funciona con cualquier servidor de archivos estáticos. macOS y la mayoría de las distribuciones de Linux ya traen Python 3:

```bash
cd motion-fitness-game
python3 -m http.server 4174 --bind 127.0.0.1
```

En Windows, si tienes Python instalado, cambia `python3` por `python`:

```powershell
cd motion-fitness-game
python -m http.server 4174 --bind 127.0.0.1
```

> ⚠️ Necesitas **Python 3.9 o superior**: las versiones más antiguas no devuelven el tipo `application/wasm` correcto para los archivos `.wasm`,
> y el navegador se negará a cargar el modelo de postura. Si no tienes un Python reciente, con Node te será mucho más fácil.

---

## Iniciar y acceder

**Con Node (recomendado):**

```bash
cd motion-fitness-game
node preview-server.js
```

Deberías ver estas dos líneas (el script imprime una en chino y otra en inglés):

```
体感健身游戏预览地址： http://127.0.0.1:4174
Motion Fitness is running at: http://127.0.0.1:4174
```

**Con Python:** mira el apartado anterior; se accede igual, al puerto 4174.

Y después abre en el navegador:

### 👉 <http://127.0.0.1:4174>

La primera vez, pulsa «Activar la cámara» → elige «Permitir» en la ventana del navegador → elige un ejercicio → **entra dentro del contorno punteado que aparece en la imagen**;
en cuanto se reconozca tu cuerpo entero (el contorno punteado desaparece), la cuenta atrás 3-2-1 se lanza automáticamente y empieza el conteo.

> ⚠️ **No hagas doble clic directamente en `index.html`**. Si abres la página con `file://`, el navegador bloqueará la cámara y la carga del wasm,
> así que tienes que entrar por `http://127.0.0.1:...` (localhost se considera un contexto seguro).

**Cambiar de puerto / dejar que entren otras personas**

```bash
# Windows PowerShell
$env:PORT=8080; node preview-server.js

# macOS / Linux
PORT=8080 node preview-server.js
```

Por defecto solo escucha en `127.0.0.1` (solo accesible desde tu propio equipo): eso protege tu privacidad y además evita que se conecte cualquier otra persona de la misma red.

---

## Permisos de cámara

### Windows

1. **Configuración → Privacidad y seguridad → Cámara**
   - Activa «**Acceso a la cámara**»
   - Activa «**Permitir que las aplicaciones accedan a tu cámara**»
   - Baja hasta «**Permitir que las aplicaciones de escritorio accedan a tu cámara**» y comprueba que está activado
2. En el navegador, pulsa el icono 🔒 / de cámara que hay a la izquierda de la barra de direcciones → cambia «Cámara» a **Permitir** y recarga la página
3. La primera vez que ejecutes `node`, es posible que el Firewall de Windows muestre un aviso: como el servidor solo escucha en 127.0.0.1, **da igual si permites o cancelas, no afecta al funcionamiento**

### macOS

1. La primera vez que pulses «Activar la cámara», el navegador mostrará la ventana de autorización del sistema → pulsa «**Permitir**»
2. Si antes pulsaste «No permitir» por error: **Ajustes del Sistema → Privacidad y seguridad → Cámara** → marca el navegador que uses (Chrome / Safari / Edge) y después **cierra el navegador por completo y vuelve a abrirlo**
3. Si usas Safari, ojo: Safari necesita que permitas este sitio en «Ajustes → Sitios web → Cámara»

### Linux

1. Comprueba que `/dev/video*` existe y que tienes permisos (mira el apartado «Instalar Node.js en Linux» de más arriba)
2. En el navegador, pulsa el icono de la izquierda de la barra de direcciones → permite la cámara
3. Si usas una versión del navegador de Flatpak / Snap, puede que tengas que autorizar el dispositivo de cámara en los ajustes del sistema o con `flatpak override --device=all`

---

## Calibración previa

Cuando hayas elegido el ejercicio, en la imagen aparece una **silueta punteada del cuerpo**: una línea de contorno exterior limpia (no es un esqueleto articulado), y ese es tu objetivo de postura;
arriba aparece además una línea de texto que te dice directamente «entra dentro del contorno punteado». El panel de calibración va marcando cada comprobación: **solo «Cuerpo detectado» y «Cuerpo entero visible» son obligatorias** (✓ si cumple; ○ si no cumple, bloquea el inicio);
las otras cinco se marcan con «·» y son solo **recomendaciones**: seguirlas hace que el reconocimiento sea más preciso, pero no impiden empezar.

| Comprobación | Significado |
|---|---|
| Cuerpo detectado (**obligatorio**) | La cámara te ve bien |
| Cuerpo entero visible (**obligatorio**) | De la cabeza a los pies, todo dentro del encuadre, sin cortes en los bordes |
| Distancia correcta (recomendado) | Tu cuerpo ocupa el tamaño adecuado en la imagen (si estás demasiado lejos o demasiado cerca, te indica hacia dónde moverte) |
| Bien centrado (recomendado) | Tu cuerpo queda en el centro del contorno |
| Altura correcta (recomendado) | Tu posición vertical dentro del encuadre es la adecuada |
| Ángulo correcto (recomendado) | En la sentadilla hay que **ponerse de frente** a la cámara; en el resto de ejercicios, **de perfil** |
| Sin moverte (recomendado) | Estar quieto hace que el reconocimiento sea más estable (también puedes empezar sin quedarte quieto) |

**Cada ejercicio tiene su propia silueta** (se elige automáticamente según el ángulo de cámara y la postura del ejercicio), así que solo tienes que colocarte y encajar con el contorno:
los ejercicios de frente (sentadilla con peso corporal / sentadilla sumo / sentadilla con salto / salto al cajón / burpee) usan una silueta de pie de frente; los ejercicios de pie, una silueta de pie de perfil;
los de flexión (incluido el escalador) usan una **posición alta de flexión, vista de perfil** (brazos estirados apoyados en el suelo); la plancha y la plancha lateral, una **posición tumbada de perfil apoyada en los antebrazos** (cuerpo bajo, sobre los antebrazos);
y los ejercicios tumbados como el puente de glúteos / los encogimientos / la elevación de piernas tumbado / el bicho muerto usan una **postura tumbada boca arriba de perfil con las piernas dobladas** (boca arriba, rodillas dobladas, pies apoyados en el suelo).
Al grabar de perfil, el contorno se voltea automáticamente de izquierda a derecha según hacia dónde estés mirando.

Cuando las dos comprobaciones obligatorias están correctas y se mantienen unos 0,6 s, **el contorno punteado desaparece al instante** (esa es la señal de que se ha reconocido tu cuerpo entero),
y después se lanza automáticamente la cuenta atrás 3-2-1 que inicia el conteo: no hay que pulsar ningún botón.
Al terminar una serie vuelves a la calibración: esta vez el contorno se queda en verde y eres tú quien empieza la serie siguiente con «Empezar» (o la barra espaciadora) —
así puedes descansar y mirar el resumen sin que te arrastre enseguida a la serie siguiente.

> Si no estás bien colocado, el texto que aparece arriba de la imagen y el panel de calibración te dicen directamente qué hacer (por ejemplo «acércate un poco a la cámara», «desplázate un poco a la derecha», «ponte de frente a la cámara»),
> así que nunca te quedas sin saber qué falla.
> En los ejercicios tumbado (flexión / plancha / puente de glúteos) la distancia se mide por la **longitud del cuerpo**, así que no hace falta que te levantes.
> Para volver a calibrar: pulsa el botón «Volver a calibrar» que hay debajo de la imagen; además, cada vez que terminas una serie vuelves automáticamente a la calibración.

---

## Página de inicio y página del ejercicio

**Página de inicio**: al entrar lo primero que ves es un muro de ejercicios por categorías, dividido en cinco bloques — **tren superior / tren inferior / core / cuerpo completo / estiramientos** —,
y dentro de cada bloque cada ejercicio tiene su tarjeta: icono, nombre, si cuenta repeticiones o cronometra, el objetivo por defecto y el **criterio de detección** (por lo que se evalúa ese ejercicio).
Con el buscador de arriba puedes encontrar un ejercicio directamente por su nombre (por ejemplo, escribe «flexión» o «push»).

- Pulsa cualquier tarjeta → entras en la **página del ejercicio** (cámara + lista de pasos de la técnica + puntuación + ajuste del objetivo + registros).
  La página del ejercicio tiene su propia dirección: `#/ex/<id>` (por ejemplo `#/ex/bridge`), así que **al recargar sigues en el mismo ejercicio**,
  **el botón Atrás del navegador vuelve al inicio** y puedes guardar el enlace en favoritos.
- Con «Volver al inicio», arriba a la izquierda de la página del ejercicio, vuelves al muro de ejercicios; arriba a la derecha está ⚙️ **Ajustes**.
- Un ejercicio que pertenece a dos categorías (la sentadilla con salto) aparece en los dos bloques, pero al entrar es el mismo ejercicio.

## Ventana de ajustes (idioma / modelo / sonido)

Pulsa ⚙️ arriba a la derecha de la página del ejercicio y se abre la ventana de ajustes, que reúne todos los interruptores:

| Grupo | Opciones |
|---|---|
| Idioma | 中文 / English / Español / Français (se aplica al instante: cambian a la vez los nombres de los ejercicios y los pasos de la técnica) |
| Modelo de detección | Ligero (fluido, por defecto) / Completo (más preciso; la primera vez que cambias hay que descargar un modelo adicional y a partir de ahí funciona sin conexión) |
| Sonido | 🔊 Voz · 🎵 Efectos · 🎶 Música de fondo |
| Imagen y detección | 🪞 Espejo · ✅ Modo estricto · 🦴 Esqueleto · 📐 Ángulos · 🐞 Métricas |

Puedes cerrarla pulsando fuera de la ventana o con `Esc` y `G`.

---

## Cómo usarlo: la posición de la cámara es clave

**Cámara de frente: sentadilla con peso corporal, sentadilla sumo, sentadilla con salto, salto al cajón y burpee; el resto de ejercicios se hacen de perfil a la cámara.**
La primera línea de «la técnica del ejercicio», dentro de la página del ejercicio, te dice cómo colocarte (cada tarjeta indica además su criterio de detección).

- **Ejercicios de frente** (sentadilla con peso corporal / sentadilla sumo / sentadilla con salto / salto al cajón / burpee): de frente a la cámara. La profundidad se mide con «cuánto más alta está la cadera que la rodilla»,
  un valor que en vista frontal no se comprime; y además **solo de frente a la cámara se ve si las rodillas se meten hacia dentro** y si los dos lados son simétricos.

- A **2-3 m** de la cámara, con **el cuerpo entero dentro del encuadre** (de la cabeza a los pies);
- **Zancada al frente / sentadilla búlgara**: de pie y de perfil a la cámara, de forma que en el encuadre se vean a la vez tobillos, rodillas, cadera y hombros;
- **Flexión / plancha / escaladores**: el cuerpo en perpendicular a la cámara, con las manos y los pies dentro del encuadre;
- **Puente de glúteos / encogimientos / elevación de piernas tumbado / bicho muerto / plancha lateral**: tumbado de lado, de forma que se vean a la vez hombros, cadera, rodillas y tobillos;
- **Estiramientos**: en la flexión de pie, de pie y de perfil a la cámara; en la flexión sentado, sentado en el suelo y de perfil;
- Con una luz uniforme y un fondo no demasiado recargado; la ropa ajustada hace que el reconocimiento sea más estable.
- **¿Sin sonido?** ① comprueba que la pestaña no esté silenciada (icono del altavoz) ② abre ⚙️ Ajustes y pulsa una vez «🔊 Voz»: reproduce una frase de prueba al instante ③ abre «🐞 Métricas»: la última línea muestra «Sonido» como `running` y un número de voces mayor que 0.

**Fíjate en el orden: eliges el ejercicio → entras en el contorno punteado → se reconoce tu cuerpo entero (el contorno punteado desaparece) → cuenta atrás 3-2-1 automática → empieza el conteo;
al terminar una serie vuelves a la calibración y pulsas «Empezar» (o la barra espaciadora) para la serie siguiente.**
La fase de calibración solo comprueba la colocación: no cuenta repeticiones ni da puntos.

**Atajos de teclado**: `1`–`9` cambiar de ejercicio · `H` inicio · `G` ajustes · `Espacio` iniciar/pausar · `R` reiniciar el conteo · `Esc` terminar la serie · `M` espejo · `S` esqueleto · `F` pantalla completa del vídeo

---

## Catálogo de ejercicios (22 ejercicios)

| Categoría | Ejercicio (icono) | Tipo | Criterio de detección | Objetivo por defecto |
|---|---|---|---|---|
| 💪 Tren superior | Flexión estándar 💪 | Repeticiones | Flexión de codo | 12 reps |
| 💪 Tren superior | Flexiones abiertas ↔️ | Repeticiones | Flexión de codo | 12 reps |
| 💪 Tren superior | Flexiones diamante 💎 | Repeticiones | Flexión de codo | 10 reps |
| 🦵 Tren inferior | Sentadilla con peso corporal 🏋️ | Repeticiones | Flexión de rodilla (profundidad en vista frontal) | 15 reps |
| 🦵 Tren inferior | Sentadilla sumo 🤼 | Repeticiones | Flexión de rodilla | 15 reps |
| 🦵 Tren inferior | Sentadilla búlgara 🦵 | Repeticiones | Flexión de rodilla | 12 reps |
| 🦵 Tren inferior | Zancada al frente 🚶 | Repeticiones | Ángulo de la rodilla delantera + altura de la rodilla trasera | 16 reps |
| 🦵 Tren inferior | Zancada atrás ↩️ | Repeticiones | Flexión de rodilla | 16 reps |
| 🦵 Tren inferior | Puente de glúteos 🌉 | Repeticiones | Altura de la cadera | 15 reps |
| 🦵 Tren inferior | Sentadilla con salto 🚀 | Repeticiones | Flexión de rodilla + pies en el aire | 12 reps |
| 🔥 Core | Plancha 🧘 | Cronómetro | Tiempo aguantando la postura | 45 s |
| 🔥 Core | Plancha lateral 🧎 | Cronómetro | Corrección de la postura (detección aproximada) | 30 s |
| 🔥 Core | Bicho muerto 🐞 | Repeticiones | Alternancia de piernas | 16 reps |
| 🔥 Core | Encogimientos 🌀 | Repeticiones | Altura de los hombros respecto al suelo | 20 reps |
| 🔥 Core | Encogimientos inversos 🔃 | Repeticiones | Plegado de cadera | 15 reps |
| 🔥 Core | Elevación de piernas tumbado 🦿 | Repeticiones | Plegado de cadera | 15 reps |
| 🤸 Cuerpo completo | Burpee 💥 | Repeticiones | Orden de la secuencia (sentadilla → apoyo → salto) | 10 reps |
| 🤸 Cuerpo completo | Escaladores ⛰️ | Repeticiones | Alternancia de piernas | 24 reps |
| 🤸 Cuerpo completo | Salto al cajón 🦘 | Repeticiones | Flexión de rodilla + pies en el aire (detección aproximada) | 10 reps |
| 🤸 Cuerpo completo | Sentadilla con salto 🚀 | Repeticiones | Flexión de rodilla + pies en el aire | 12 reps |
| 🤸 Cuerpo completo | Zancada con salto ⤴️ | Repeticiones | Flexión de rodilla + pies en el aire | 14 reps |
| 🧘 Estiramientos | Flexión de pie 🙇 | Cronómetro | Corrección de la postura | 30 s |
| 🧘 Estiramientos | Flexión sentado 🧎‍♂️ | Cronómetro | Corrección de la postura | 30 s |

> La «sentadilla con salto» pertenece a la vez a tren inferior y a cuerpo completo: un mismo ejercicio puede aparecer en varias categorías (según cuántas categorías tengas en su lista `cats`).
> El criterio de detección es **lo que la cámara mide de verdad**; los ejercicios marcados como **detección aproximada** (plancha lateral, salto al cajón, etc.) solo pueden comprobar que «la postura está más o menos bien»:
> la puntuación y el cronómetro funcionan igual, pero no lo tomes como un árbitro estricto de la postura.

---

## Reglas de puntuación

A la derecha de la interfaz tienes una **lista de pasos de la técnica**: cada paso correcto se marca al instante con una casilla, suma puntos y suena un aviso, y el paso que te toca hacer ahora aparece resaltado.
Si **completas todos los pasos de la ronda** te llevas además una bonificación de puntuación perfecta; en los ejercicios de cronómetro, **cada segundo aguantado suma 1 punto más**.

### Sentadilla (45 puntos por ronda)

En la sentadilla se usa la **vista frontal** y la profundidad se mide con «cuánto más alta está la cadera que la rodilla / longitud de la pantorrilla» (de pie ≈ 1.0; con el muslo horizontal ≈ 0):

| Paso | Condición | Puntos |
|---|---|---|
| ① Ponte de frente a la cámara, con el cuerpo entero en el encuadre y recto | Vista frontal + cuerpo entero visible + cuerpo vertical + cadera claramente más alta que la rodilla (ratio >0.86) | +4 |
| ② Flexiona las rodillas y baja la cadera | Ratio de altura cadera-rodilla ≤0.72 (muslo a unos 46° de la horizontal) | +6 |
| ③ Flexiona las rodillas siguiendo la dirección de los pies y baja | Ratio ≤0.50 (unos 30°) | +7 |
| ④ **Baja hasta que el muslo quede casi horizontal** | Ratio ≤0.25 (muslo a 15° o menos de la horizontal, o más abajo) | **+14** |
| ⑤ Empuja con los pies y sube con cadera y rodillas del todo extendidas | El ratio vuelve a ≥0.80 | +8 |
| 🎁 Todos los pasos de la ronda | Los 5 pasos anteriores completados en la misma ronda | +6 |

### Zancada (54 puntos por ronda)

| Paso | Condición | Puntos |
|---|---|---|
| ① Colócate de perfil a la cámara, con el cuerpo entero en el encuadre y recto | Vista lateral + cuerpo entero visible + cuerpo recto + las dos piernas casi estiradas | +4 |
| ② Da un paso hacia delante con una pierna y separa los pies | Distancia entre tobillos > 0.45 veces la longitud del torso | +5 |
| ③ Da un paso bien largo (más distancia entre los pies) | Distancia entre tobillos > 0.9 veces la longitud del torso | +6 |
| ④ Flexiona las dos rodillas a la vez y baja; la de delante, a unos 90° | La pierna más flexionada ≤118° y la otra ≤150° | +11 |
| ⑤ **Baja la rodilla de atrás hasta casi el suelo** | Altura de la rodilla de atrás respecto al suelo ≤0.35 veces la longitud de la pantorrilla | **+14** |
| ⑥ Empuja con el pie de delante y vuelve de pie | Las dos piernas se estiran otra vez (tienes que haber bajado antes) | +8 |
| 🎁 Todos los pasos de la ronda | Los 6 pasos anteriores completados en la misma ronda | +6 |

### Flexión (40 puntos por ronda)

| Paso | Condición | Puntos |
|---|---|---|
| ① Apoya las manos en el suelo con el cuerpo en línea recta | Postura boca abajo + ángulo del cuerpo en línea ≥165° + sin hundir la lumbar ni levantar el trasero | +5 |
| ② Activa el core y baja flexionando los codos | Ángulo del codo ≤140° | +7 |
| ③ **Flexiona los codos por debajo de 90°** | Ángulo del codo ≤95° y el cuerpo sigue en línea recta | **+14** |
| ④ Empuja hacia arriba hasta estirar los brazos del todo | Ángulo del codo ≥145° (tienes que haber bajado antes) | +8 |
| 🎁 Todos los pasos de la ronda | Los 4 pasos anteriores completados en la misma ronda | +6 |

### Puente de glúteos (39 puntos por ronda)

| Paso | Condición | Puntos |
|---|---|---|
| ① Túmbate boca arriba con las rodillas flexionadas y los pies apoyados a la anchura de la cadera | Postura tumbado boca arriba con las rodillas flexionadas (hombros en el suelo y rodillas levantadas) | +5 |
| ② Aprieta los glúteos y sube la cadera | Elevación de cadera > 0.15 veces la longitud del torso | +6 |
| ③ **Sube hasta que hombro, cadera y rodilla queden casi en línea** | Elevación de cadera > 0.35 veces la longitud del torso | **+14** |
| ④ Baja el glúteo al suelo con control | Vuelve al suelo (tienes que haber subido antes) | +8 |
| 🎁 Todos los pasos de la ronda | Los 4 pasos anteriores completados en la misma ronda | +6 |

### Plancha (70 puntos por ronda + 1 punto por segundo)

| Paso | Condición | Puntos |
|---|---|---|
| ① Apoya los antebrazos bajo los hombros y levanta el cuerpo | Hombros separados del suelo + manos o antebrazos apoyados + ángulo de codo válido | +8 |
| ② Cabeza, espalda, cadera y tobillos en línea recta | Ángulo del cuerpo en línea ≥148° + sin hundir la lumbar ni levantar el trasero | +12 |
| ③ Aguanta 3 segundos sin moverte | Mantener 3 segundos completos | +10 |
| ④ Aguanta 10 segundos sin moverte | Mantener 10 segundos completos | +15 |
| ⑤ Aguanta 30 segundos sin moverte | Mantener 30 segundos completos | +25 |
| ⏱ Cada segundo que aguantas | Mientras la postura sea válida | +1/s |
> **La plancha se evalúa de forma permisiva**: el cronómetro arranca en cuanto «el cuerpo está más o menos plano + los hombros separados del suelo + las manos o antebrazos cerca del suelo».
> Hundir la lumbar, levantar el trasero, no estar perfectamente alineado o tener las rodillas bajas solo provocan **una corrección por voz y un descuento de calidad** — ya no pausan el cronómetro;
> solo «no has llegado a hacer la plancha» (de pie, tumbado sin más) detiene el tiempo. Lo mismo vale para el resto de ejercicios cronometrados: los pequeños temblores dentro del margen de 1,2 s no interrumpen.

### Sobre los ejercicios que no están en la lista

> Esta versión del catálogo se ha ajustado a la lista de 22 ejercicios indicada por el usuario, y el puente estático no está entre ellos; si lo quieres,
> duplica en `src/catalog.js` una entrada `bridge`, cambia el `kind` a `'hold'` y vuelve a ejecutar `npm test` para recuperarlo
> (tanto el motor de reconocimiento como el plan de puntuación ya están hechos; mira [añadir ejercicios](#añadir-ejercicios--ajustar-puntos--cambiar-umbrales)).

### Familias genéricas de puntuación

Además de los 5 planes escritos a mano de arriba, el resto de ejercicios comparten 8 **planes de familia** (los ejercicios de una misma familia se evalúan con la misma lógica, solo cambian los umbrales):

| Plan de familia | En qué ejercicios se usa | Pasos |
|---|---|---|
| Flexión-extensión de pie | Sentadilla sumo, sentadilla búlgara, zancada atrás | Colócate de pie → flexiona las rodillas y baja → llega a la amplitud objetivo → empuja con los pies y vuelve |
| Flexión-extensión en apoyo boca abajo | Flexiones abiertas / diamante | Apóyate en línea recta → flexiona los codos y baja → hasta la profundidad objetivo → empuja y vuelve arriba |
| Elevación tumbado boca arriba | Encogimientos, encogimientos inversos, elevación de piernas tumbado | Túmbate → inicia el impulso → sube hasta el punto → baja con control |
| Alternancia izquierda-derecha | Bicho muerto, escaladores | Colócate → primer recogida / extensión → cambia al otro lado → mantén el ritmo |
| Movimiento por fases | Burpee | Ponte de pie → agáchate y apoya las manos en el suelo → completa la fase intermedia → levántate y cierra |
| Saltos | Sentadilla con salto, zancada con salto, salto al cajón | Ponte de pie → flexiona las rodillas para cargar → **los pies en el aire** → flexiona las rodillas al aterrizar |
| Cronómetro (postura) | Plancha lateral | Colócate → cuerpo en línea recta → aguanta 3 / 10 / 30 s |
| Cronómetro (estiramientos) | Flexión de pie, flexión sentado | Entra en la postura de estiramiento → relájate y respira → mantén 10 / 20 s |

En los planes de familia de cronómetro también **sumas +1 punto por cada segundo que aguantas**; si la postura se viene abajo más de 1,2 segundos, el cronómetro se pausa y la voz te avisa.

### Sonidos y avisos de voz

| Momento | Respuesta |
|---|---|
| Cumples un paso de la técnica | **Un aviso sonoro ascendente** + la animación `+12` que sale volando en pantalla |
| Completas todos los pasos de la ronda | Acorde ascendente de tres notas de «puntuación perfecta» + texto flotante con los puntos |
| Primera vez que cumples cada paso | **La voz anuncia ese paso**; a partir de ahí solo suena el aviso, sin voz, para no saturar |
| Cada 50 puntos que pasas | Aviso sonoro ascendente + la voz dice la puntuación + felicitación en pantalla |
| Una repetición válida más | Nota de conteo de escala pentatónica + la voz canta el número |
| Una repetición que no cuenta | Sonido grave de «puf» + un aviso en pantalla con el problema |
| Mientras aguantas en un ejercicio de cronómetro | Un toque suave cada segundo + los puntos suben sin parar |
| Objetivo cumplido / fin de la serie | Acorde de celebración + texto flotante del objetivo + panel de resumen (con los puntos y los pasos que te han faltado) |

Tanto los sonidos como la voz se pueden desactivar con un solo clic desde la ventana de ⚙️ Ajustes.

---

## Idiomas

La interfaz incluye cuatro idiomas; cambia cuando quieras desde el desplegable **Idioma** de ⚙️ Ajustes y tu elección se recordará:

| Idioma | Código | Archivo de textos |
|---|---|---|
| 中文 | `zh` | `src/locales/zh.js` |
| English | `en` | `src/locales/en.js` |
| Español | `es` | `src/locales/es.js` |
| Français | `fr` | `src/locales/fr.js` |

La primera vez se elige automáticamente según el idioma del navegador (chino / inglés / español / francés; cualquier otro idioma recurre al inglés).

**Añadir un idioma nuevo**: copia `src/locales/en.js` y adáptalo al idioma nuevo, impórtalo en `src/i18n.js` y añádelo a `LOCALES`;
después vuelve a ejecutar `npm run test:i18n` —— la prueba revisa una por una las claves que faltan, las traducciones sin hacer, los marcadores y la longitud de los arrays, así no se te escapa nada.

---

## Si no entras en el contorno o no pasa nada: cuatro pasos de diagnóstico

**① Confirma primero la versión.** Junto al título de la página tiene que aparecer `v3.0`. Si no lo ves, es que el navegador sigue usando una versión antigua en caché: pulsa **Ctrl + F5** (en Mac, Cmd + Shift + R) para forzar la recarga.

**② Mira primero el panel «Calibración previa» de la derecha.** De las siete comprobaciones, la que no esté marcada te dice lo que tienes que hacer, siguiendo la frase que aparece debajo del panel:

| Mensaje del panel | Significado |
|---|---|
| No veo bien todo tu cuerpo: retrocede un poco… | El modelo no te encuentra o alguna parte del cuerpo se sale del encuadre |
| Estás demasiado lejos / demasiado cerca de la cámara: acércate un poco / retrocede un poco | Tu cuerpo no ocupa el tamaño adecuado en el encuadre |
| Muévete un poco a la derecha / a la izquierda, al centro del contorno | No estás centrado |
| Sitúate un poco más arriba / más abajo en el encuadre | La posición vertical no es la correcta |
| Ponte de frente a la cámara / Ponte de perfil a la cámara | El ángulo no coincide con el ejercicio actual |
| Muy bien, no te muevas… | Solo falta el último segundo |

**③ Después, mira la barra de estado que hay debajo de la imagen**: muestra la misma frase; cuando ya has empezado a entrenar, indica «qué toca hacer ahora y cuánto te falta».

**④ Activa «🐞 Métricas» desde ⚙️ Ajustes (arriba a la derecha)** (funciona tanto en la calibración como durante el entrenamiento). Debajo de la imagen verás en tiempo real los números que ve el detector, por ejemplo:

```
Vista Lateral ✓(0.18) · Cuerpo entero ✓ · Piernas visibles ✓ · Inclinación del torso 6° · Rodilla 176° · Codo 172° ·
Cadera 172° · Cuerpo en línea 175° · Elevación de cadera -0.98 · Muslo respecto a la horizontal 88° · Visibilidad 0.94 · Estado running
```

Compáralo con esta tabla:

| Síntoma | Causa | Solución |
|---|---|---|
| `Vista Lateral ✗(0.90)` | El ángulo no coincide con lo que pide el ejercicio actual (los cinco ejercicios frontales van de frente y el resto, de perfil) | Gírate siguiendo lo que indica la barra de estado; sentadilla de frente y el resto de perfil |
| `Cuerpo entero ✗` | Alguna parte del cuerpo se sale del encuadre | Retrocede 1-2 pasos para que entren la cabeza y los pies |
| `No se detecta cuerpo` | Estás demasiado lejos o demasiado cerca, hay contraluz, o el fondo y la ropa son del mismo color | Acércate un poco, ponte de cara a la luz, cámbiate de ropa o usa una cámara con más resolución |
| `Inclinación del torso` siempre > 32° | La cámara está torcida o no estás recto | Nivela la cámara (o ponle unos libros debajo para calzarla) |
| Los números están bien pero no se marca la casilla | Te has quedado justo en el umbral de un paso | La barra de estado te dice exactamente cuánto te falta (por ejemplo, «ya has bajado hasta el 62 % (100 % = muslo horizontal)») |

---

## Preguntas frecuentes

**P: ¿Qué hago si el puerto 4174 está ocupado?**
Arranca el servidor con otro puerto: `PORT=8080 node preview-server.js` (en Windows, `$env:PORT=8080; node preview-server.js`).
Para ver qué lo está ocupando: en macOS/Linux, `lsof -i :4174`; en Windows, `netstat -ano | findstr 4174`.

**P: El navegador dice «cámara no disponible / NotAllowedError», ¿qué pasa?**
Activa los permisos en los dos niveles, sistema y navegador, como se explica en «Permisos de cámara», y después **cierra el navegador por completo y vuelve a abrirlo**.

**P: La página avisa «no se pudo cargar el modelo de postura», ¿qué pasa?**
Lo más probable es que el MIME del `.wasm` no sea el correcto. Lo más fiable es usar el `node preview-server.js` incluido; con Python necesitas 3.9 o superior.
Comprueba además que la carpeta `vendor/` esté completa (al descargar el ZIP de GitHub es muy fácil olvidarse de descomprimir la carpeta entera).

**P: ¿La imagen va a tirones o con pocos FPS?**
Cambia el **Modelo de detección** de ⚙️ Ajustes a **Ligero**; desactiva «📐 Ángulos»; o usa un equipo con más potencia. El reconocimiento sigue siendo útil a 10-15 FPS.

**P: ¿Funciona en el móvil?**
Sí. Abre la misma dirección en el navegador del móvil (el móvil y el ordenador tienen que estar en la misma red local, y el servidor debe escuchar en `0.0.0.0`:
cambia `'127.0.0.1'` por `'0.0.0.0'` en `preview-server.js` y reinícialo). Ojo, porque así también podrá acceder cualquier otra persona de la misma red.

**P: ¿Dónde se guardan los datos?**
El historial de entrenamientos y las mejores marcas se guardan en el localStorage del navegador: si cambias de navegador o borras la caché se pierden, y no se suben a ningún servidor.

---

## Pruebas

```bash
npm test                       # las cinco suites juntas (902 pruebas)
npm run test:i18n              # idiomas: claves ausentes / sin traducir / marcadores / arrays / chino escrito a fuego en el código / estructura de los cuatro README
npm run test:detectors         # lógica de detección y puntuación de los cinco detectores escritos a mano (con esqueletos sintéticos)
npm run test:engines           # motores de reconocimiento genéricos (flexión-extensión / alternancia / giro / movimiento por fases / cronómetro + control de postura)
npm run test:dump              # imprime además las métricas de postura de referencia, para ajustar umbrales
npm run test:page              # autochequeo del cableado de la página (ids del DOM / imports / recursos estáticos / catálogo de 22 ejercicios y lista de categorías)
npm run test:app               # prueba de integración: app.js real cargado sobre un DOM mínimo de prueba
```

| Archivo de prueba | N.º de pruebas | Cobertura |
|---|---|---|
| `tests/test-i18n.mjs` | 32 | Estructura de claves idéntica en los cuatro idiomas, sin traducciones pendientes, mismos marcadores y misma longitud de arrays, sin chino escrito a fuego en el código fuente y estructura idéntica en los cuatro documentos |
| `tests/test-detectors.mjs` | 222 | Conteo, cronómetro, puntos por paso y orden de puntuación de los cinco detectores escritos a mano, tanto con el ejercicio bien hecho como con todo tipo de errores, además de las comprobaciones de la calibración previa |
| `tests/test-engines.mjs` | 138 | Motores genéricos: un ciclo y una repetición, permisivo frente a estricto, los límites del balanceo y de la velocidad excesiva, control de postura, despegue del suelo en los saltos, alternancia de lados, secuencia completa y pausa y reanudación del cronómetro |
| `tests/test-page.mjs` | 310 | Cableado del DOM, importación y exportación de módulos, recursos estáticos, lista de categorías de los 22 ejercicios e integridad de los planes de puntuación |
| `tests/test-app.mjs` | 200 | Arranque del `app.js` real, renderizado de la página de inicio, ventana de ajustes, flujo de calibración, cambio de ejercicio, puntuación, sonidos, resumen y cambio de idioma |

---

## Estructura del proyecto

```
motion-fitness-game/
├─ index.html            Estructura de la página (los textos van por data-i18n)
├─ style.css             Estilos de la interfaz en modo oscuro
├─ preview-server.js     Servidor local sin dependencias (http://127.0.0.1:4174)
├─ src/
│  ├─ i18n.js            ★ Núcleo de idiomas (t / setLang / applyI18n)
│  ├─ locales/           ★ Los cuatro archivos de textos: zh.js / en.js / es.js / fr.js
│  ├─ catalog.js         ★ Catálogo de ejercicios: las cinco categorías + los 22 ejercicios (icono, tipo, motor, umbrales, criterio de detección)
│  ├─ geometry.js        Geometría y tratamiento de señal (ángulos, suavizado One Euro)
│  ├─ metrics.js         Métricas del ejercicio en cada fotograma (ángulos de las articulaciones, elevación de cadera, altura respecto al suelo, alineación del cuerpo…)
│  ├─ steps.js           ★ «Pasos de puntuación de la técnica» de cada ejercicio (condición + puntos + clave del aviso)
│  ├─ calibration.js     ★ Calibración previa: contorno de la silueta punteada del cuerpo + las siete comprobaciones de colocación
│  ├─ detector-base.js   Clase base de los detectores (puntuación por pasos, limitación de avisos, gestión de fotogramas perdidos)
│  ├─ engines.js         ★ Motores de reconocimiento genéricos (flexión-extensión / alternancia / giro / movimiento por fases / cronómetro + control de postura)
│  ├─ exercises.js       ★ Los cinco detectores escritos a mano (sentadilla con peso corporal / zancada al frente / flexión / puente de glúteos / plancha) + fábrica
│  ├─ pose-engine.js     Envoltorio de MediaPipe PoseLandmarker + gestión de la cámara
│  ├─ render.js          Dibujo del esqueleto
│  ├─ audio.js           Sonidos + avisos de voz (según el idioma)
│  └─ app.js             Interfaz, página de inicio, ventana de ajustes, flujo de entrenamiento, lista de pasos, registros y bucle principal
├─ tests/                Las cinco suites de pruebas automatizadas
└─ vendor/               MediaPipe tasks-vision (wasm) y modelo de postura (offline)
```

---

## Añadir ejercicios / ajustar puntos / cambiar umbrales

**Para añadir un ejercicio basta con añadir una entrada al catálogo** (no hay que escribir código de reconocimiento):

1. Añade una línea dentro de `EXERCISES`, en `src/catalog.js`, por ejemplo
   `e('myMove', '🔧', ['core'], { plan: 'repSupine', posture: 'supine', judge: 'clear', target: 15, params: bend({ metric: 'kneeClear', gate: 'supineLow', up: 0.15, down: 0.85 }) })`;
2. Añade `myMove: { name, cameraHint, goal }` en el apartado `ex` de los cuatro archivos `src/locales/*.js`
   (los pasos de la técnica y los consejos toman automáticamente la plantilla de la «familia» a la que pertenece; si los quieres escribir tú, añade `howto` / `tips`);
3. Ejecuta `npm test`: las pruebas comprueban que estén completas las cinco listas por categoría, los textos de los cuatro idiomas y el detector y el plan de puntuación de cada ejercicio.

- **Cambiar los puntos o el texto de un paso**: edita `src/steps.js` (estructura y puntos) y `src/locales/*.js` (textos).
  Cada paso es un objeto `{ id, labelKey, points, check, hint }`; si `check(frame, det)` devuelve `true`, ese paso cuenta como cumplido.
- **Cambiar los umbrales de decisión**:
  - **Ejercicios con motor genérico** (la gran mayoría del catálogo): cambia los `params` de ese ejercicio en `src/catalog.js` —
    `metric` qué valor se usa (`kneeBent` / `elbow` / `hipRise` / `kneeClear` / `shoulderClear` …),
    `gate` qué postura se exige (`stand` / `prone` / `supine` / `seated` / `sideLying` …),
    `up` valor inicial, `down` valor de llegada, `looseP` línea de conteo permisiva, `minRepMs` tiempo mínimo de una repetición, `flight` si se exige despegar los pies del suelo;
  - **Los cinco detectores escritos a mano**: cambia las constantes correspondientes de `src/exercises.js` (todas llevan comentarios en chino) —
    `SQUAT_FRONT` (en `src/steps.js`): `standRatio` 0.86 / `enterRatio` 0.78 / `bottomRatio` 0.40 /
    `looseRatio` 0.62, la unidad es «cuánto más alta está la cadera que la rodilla ÷ longitud de la pantorrilla», de pie ≈ 1.0;
    `LUNGE`: los tres niveles de ángulo de rodilla `enterKnee` 146 / `looseKnee` 142 / `downKnee` 128, y `backKneeDrop` 0.66,
    mientras que `enterHoldMs` / `exitHoldMs` son el margen de tolerancia al temblor; `PUSHUP.elbowFull` 106 / `looseElbow` 124;
    `BRIDGE.upRise` 0.22, `minRepMs` 700; `PLANK.bodyStraight` 142;
  - `HoldDetector.graceMs`: margen de gracia de los ejercicios de cronómetro (1200 ms por defecto).
  - **Permisivo / estricto**: `DetectorBase.strict` es `false` por defecto (si haces el movimiento a grandes rasgos, cuenta; la mala forma solo provoca una corrección hablada y un descuento de calidad);
    el interruptor «✅ Modo estricto» de la ventana de ajustes cambia el criterio a «solo cuenta si bajas hasta el fondo».

Cuando termines, ejecuta `npm test`: las pruebas ya incluyen la amplitud estándar de estos ejercicios, así que te dirán al momento si te has pasado.

**Cómo funciona el reconocimiento**: todos los criterios usan solo **ángulos** y **proporciones respecto a la longitud del torso**, así que no dependen de tu altura ni de la distancia a la que esté la cámara;
los puntos clave se corrigen antes según la relación de aspecto del encuadre y luego se calculan los ángulos, con un filtro One Euro para reducir el temblor. Por eso los mismos umbrales sirven para personas y colocaciones distintas.

---

## Privacidad y licencia

- La imagen se procesa solo en el navegador de tu propio equipo: **no se sube nada**. El modelo y el wasm son archivos locales, así que funcionan sin internet.
- El servidor, por defecto, solo escucha en `127.0.0.1`: nadie más de la misma red puede acceder.
- El historial de entrenamientos se guarda únicamente en el localStorage de tu navegador.
- Recursos de terceros: MediaPipe Tasks Vision (wasm) y el modelo Pose Landmarker que están en `vendor/` son de Google MediaPipe y siguen la **Apache License 2.0**.
