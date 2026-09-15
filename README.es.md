# Fitness por movimiento · Motion Fitness Game

[中文](README.md) · [English](README.en.md) · [Español](README.es.md) · [Français](README.fr.md)

Un minijuego de fitness que reconoce tus movimientos con una cámara normal: **conteo automático de sentadilla / zancada / flexión / puente de glúteos**, **cronómetro automático de plancha / puente estático**
y **puntuación paso a paso según la técnica**: cada paso que cumples suma puntos al instante, suena un aviso y la voz lo anuncia en alto.

La interfaz está disponible en **中文 / English / Español / Français**; puedes cambiar de idioma cuando quieras desde la esquina superior derecha de la página.

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
- [Calibración previa](#calibración-previa)
- [Cómo usarlo: la posición de la cámara es clave](#cómo-usarlo-la-posición-de-la-cámara-es-clave)
- [Reglas de puntuación](#reglas-de-puntuación)
- [Idiomas](#idiomas)
- [Si no entras en el contorno o no pasa nada: cuatro pasos de diagnóstico](#si-no-entras-en-el-contorno-o-no-pasa-nada-cuatro-pasos-de-diagnóstico)
- [Preguntas frecuentes](#preguntas-frecuentes)
- [Pruebas](#pruebas)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Ajustar los puntos o los umbrales por tu cuenta](#ajustar-los-puntos-o-los-umbrales-por-tu-cuenta)
- [Privacidad y licencia](#privacidad-y-licencia)

---

## Puntos destacados

- **Calibración previa**: antes de empezar, en la imagen aparece un **contorno punteado con forma de cuerpo** que te guía para colocarte dentro; cuerpo detectado, cuerpo entero visible, distancia,
  centrado, altura, ángulo y quietud: **las siete** comprobaciones tienen que estar correctas para poder empezar, así no pierdes el tiempo entrenando mal colocado.
- **Puntuación progresiva según la técnica**: cada ejercicio se divide en 4-6 pasos que se pueden evaluar; cada paso correcto suma puntos al instante, suena un aviso y se marca una casilla;
  si completas todos los pasos de la ronda, te llevas una bonificación de puntuación perfecta; en los ejercicios de cronómetro, **cada segundo aguantado suma +1 punto**.
- **Conteo con criterio**: las repeticiones a medias, demasiado rápidas, con la lumbar hundida o el trasero alto no cuentan como válidas: se cuentan aparte y te dan un aviso para corregir.
- **Estado en tiempo real**: debajo de la imagen siempre ves «en qué estado estás, en qué paso te has quedado y cuántos grados te faltan».
- **🐞 Métricas**: muestra con un clic todos los números en bruto que ve el detector (vista, visibilidad, ángulos de cada articulación), así localizas de un vistazo cualquier problema de colocación.
- **Voz con conteo + sonidos**: cada paso cumplido suena con un aviso ascendente; la primera vez que lo cumples, la voz lo anuncia, y cada 50 puntos te canta la puntuación.
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

La primera vez, pulsa «Activar la cámara» → elige «Permitir» en la ventana del navegador → elige un ejercicio → **colócate dentro del contorno punteado que aparece en la imagen**;
cuando la calibración se complete, pulsa «Empezar» y empezará el conteo.

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

Cuando hayas elegido el ejercicio, en la imagen aparece un **contorno punteado con forma de cuerpo**: ese es tu objetivo de colocación. El panel de calibración va marcando cada comprobación:

| Comprobación | Significado |
|---|---|
| Cuerpo detectado | La cámara te ve bien |
| Cuerpo entero visible | De la cabeza a los pies, todo dentro del encuadre |
| Distancia correcta | Tu cuerpo ocupa el tamaño adecuado en la imagen (si estás demasiado lejos o demasiado cerca, te indica hacia dónde moverte) |
| Bien centrado | Colócate en el centro del contorno |
| Altura correcta | Tu posición vertical dentro del encuadre es la adecuada |
| Ángulo correcto | En la sentadilla hay que **ponerse de frente** a la cámara; en el resto de ejercicios, **de perfil** |
| Sin moverte | Mantente quieto alrededor de 1 segundo, para que no te evalúe mientras te mueves |

Cuando las siete comprobaciones están correctas y se mantienen un momento, el contorno se vuelve verde y aparece «Calibración completada ✓»; en ese momento el botón «Empezar» ya está disponible.
Púlsalo (o la barra espaciadora) → cuenta atrás 3-2-1 → empieza el conteo.

> Si no estás bien colocado, debajo del panel te dice directamente qué hacer (por ejemplo «retrocede un poco», «muévete un poco a la derecha», «ponte de frente a la cámara»),
> y la barra de estado de debajo de la imagen muestra lo mismo, así que nunca te quedas sin saber qué falla.
> Para volver a calibrar: pulsa el botón «Volver a calibrar» que hay debajo de la imagen; además, cada vez que terminas una serie vuelves automáticamente a la calibración.

---

## Cómo usarlo: la posición de la cámara es clave

**En la sentadilla hay que ponerse de frente a la cámara; en los otros cinco ejercicios, de perfil**:

- **Sentadilla**: de frente a la cámara. En la sentadilla, la flexión de rodilla ocurre en el eje «de delante hacia atrás» y, al grabar de lado, ese eje cae justo sobre el eje horizontal de la imagen,
  donde se mide mejor; pero **solo de frente a la cámara se ve si las rodillas se meten hacia dentro** y si los dos lados son simétricos, así que la sentadilla se hace de frente.
  La profundidad se mide ahora con «cuánto más alta está la cadera que la rodilla», un valor que en vista frontal no se comprime y que resulta incluso más directo que el ángulo de rodilla.

- A **2-3 m** de la cámara, con **el cuerpo entero dentro del encuadre** (de la cabeza a los pies);
- **Zancada**: de pie y de perfil a la cámara, de forma que en el encuadre se vean a la vez tobillos, rodillas, cadera y hombros;
- **Flexión / plancha**: túmbate o apóyate en perpendicular a la cámara, con las manos y los pies dentro del encuadre;
- **Puente de glúteos / puente estático**: tumbado de lado, de forma que se vean a la vez hombros, cadera, rodillas y tobillos;
- Con una luz uniforme y un fondo no demasiado recargado; la ropa ajustada hace que el reconocimiento sea más estable.

**Ojo: el reconocimiento empieza en cuanto eliges el ejercicio, no hace falta pulsar «Empezar» antes.**
El conteo arranca solo después de que te coloques dentro del contorno punteado y pases la calibración.

**Atajos de teclado**: `1`–`6` cambiar de ejercicio · `Espacio` iniciar/pausar · `R` reiniciar el conteo · `Esc` terminar la serie · `M` espejo · `S` esqueleto · `F` pantalla completa

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
| ② Cabeza, espalda, cadera y tobillos en línea recta | Ángulo del cuerpo en línea ≥158° + sin hundir la lumbar ni levantar el trasero | +12 |
| ③ Aguanta 3 segundos sin moverte | Mantener 3 segundos completos | +10 |
| ④ Aguanta 10 segundos sin moverte | Mantener 10 segundos completos | +15 |
| ⑤ Aguanta 30 segundos sin moverte | Mantener 30 segundos completos | +25 |
| ⏱ Cada segundo que aguantas | Mientras la postura sea válida | +1/s |

### Puente estático (63 puntos por ronda + 1 punto por segundo)

| Paso | Condición | Puntos |
|---|---|---|
| ① Túmbate boca arriba con las rodillas flexionadas y los pies bien apoyados a la anchura de la cadera | Postura tumbado boca arriba con las rodillas flexionadas | +6 |
| ② Sube la cadera al punto más alto | Elevación de cadera > 0.32 veces la longitud del torso | +12 |
| ③ Aprieta los glúteos y aguanta 3 segundos | Mantener 3 segundos completos | +10 |
| ④ Aguanta 10 segundos | Mantener 10 segundos completos | +15 |
| ⑤ Aguanta 20 segundos | Mantener 20 segundos completos | +20 |
| ⏱ Cada segundo que aguantas | Mientras la postura sea válida | +1/s |

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

Tanto los sonidos como la voz se pueden desactivar con un solo clic desde la barra superior.

---

## Idiomas

La interfaz incluye cuatro idiomas; cambia cuando quieras desde el desplegable **Idioma** de la esquina superior derecha y tu elección se recordará:

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

**① Confirma primero la versión.** Junto al título de la página tiene que aparecer `v1.3`. Si no lo ves, es que el navegador sigue usando una versión antigua en caché: pulsa **Ctrl + F5** (en Mac, Cmd + Shift + R) para forzar la recarga.

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

**④ Activa «🐞 Métricas» en la esquina superior derecha** (funciona tanto en la calibración como durante el entrenamiento). Debajo de la imagen verás en tiempo real los números que ve el detector, por ejemplo:

```
Vista Lateral ✓(0.18) · Cuerpo entero ✓ · Piernas visibles ✓ · Inclinación del torso 6° · Rodilla 176° · Codo 172° ·
Cadera 172° · Cuerpo en línea 175° · Elevación de cadera -0.98 · Muslo respecto a la horizontal 88° · Visibilidad 0.94 · Estado running
```

Compáralo con esta tabla:

| Síntoma | Causa | Solución |
|---|---|---|
| `Vista Lateral ✗(0.90)` | El ángulo no coincide con lo que pide el ejercicio actual (la sentadilla se hace de frente y el resto, de perfil) | Gírate siguiendo lo que indica la barra de estado; sentadilla de frente y el resto de perfil |
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
Cambia el **Modelo** de la barra superior a **Ligero**; desactiva «📐 Ángulos»; o usa un equipo con más potencia. El reconocimiento sigue siendo útil a 10-15 FPS.

**P: ¿Funciona en el móvil?**
Sí. Abre la misma dirección en el navegador del móvil (el móvil y el ordenador tienen que estar en la misma red local, y el servidor debe escuchar en `0.0.0.0`:
cambia `'127.0.0.1'` por `'0.0.0.0'` en `preview-server.js` y reinícialo). Ojo, porque así también podrá acceder cualquier otra persona de la misma red.

**P: ¿Dónde se guardan los datos?**
El historial de entrenamientos y las mejores marcas se guardan en el localStorage del navegador: si cambias de navegador o borras la caché se pierden, y no se suben a ningún servidor.

---

## Pruebas

```bash
npm test                       # las cuatro suites juntas (333 pruebas)
npm run test:i18n              # idiomas: claves ausentes / sin traducir / marcadores / arrays / chino en el código
npm run test:detectors         # lógica de detección y puntuación (con esqueletos sintéticos)
npm run test:dump              # imprime además las métricas de postura de referencia, para ajustar umbrales
npm run test:page              # autochequeo del cableado de la página (ids del DOM / imports / recursos estáticos)
npm run test:app               # prueba de integración: app.js real cargado sobre un DOM mínimo de prueba
```

| Archivo de prueba | N.º de pruebas | Cobertura |
|---|---|---|
| `tests/test-i18n.mjs` | 32 | Estructura de claves idéntica en los cuatro idiomas, sin traducciones pendientes, mismos marcadores y misma longitud de arrays, sin chino escrito a fuego en el código fuente y estructura idéntica en los cuatro documentos |
| `tests/test-detectors.mjs` | 123 | Conteo, cronómetro, puntos por paso y orden de puntuación con el ejercicio bien hecho y con todo tipo de errores, además de las comprobaciones de la calibración previa |
| `tests/test-page.mjs` | 89 | Conexión con el DOM, importación y exportación de módulos, recursos estáticos y coherencia del sistema de puntuación |
| `tests/test-app.mjs` | 89 | Arranque del `app.js` real, flujo de calibración, cambio de ejercicio, puntuación, sonidos, resumen, interruptor del esqueleto y cambio de idioma |

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
│  ├─ geometry.js        Geometría y tratamiento de señal (ángulos, suavizado One Euro)
│  ├─ metrics.js         Métricas del ejercicio en cada fotograma (ángulos de las articulaciones, elevación de cadera, alineación del cuerpo…)
│  ├─ steps.js           ★ «Pasos de puntuación de la técnica» de cada ejercicio (condición + puntos + clave del aviso)
│  ├─ calibration.js     ★ Calibración previa: esqueleto objetivo del contorno punteado + las siete comprobaciones de colocación
│  ├─ exercises.js       ★ Máquina de estados del reconocimiento de los seis ejercicios + motor de puntuación
│  ├─ pose-engine.js     Envoltorio de MediaPipe PoseLandmarker + gestión de la cámara
│  ├─ render.js          Dibujo del esqueleto
│  ├─ audio.js           Sonidos + avisos de voz (según el idioma)
│  └─ app.js             Interfaz, flujo de entrenamiento, lista de pasos, registros y bucle principal
├─ tests/                Las cuatro suites de pruebas automatizadas
└─ vendor/               MediaPipe tasks-vision (wasm) y modelo de postura (offline)
```

---

## Ajustar los puntos o los umbrales por tu cuenta

- **Cambiar los puntos o el texto de un paso**: edita `src/steps.js` (estructura y puntos) y `src/locales/*.js` (textos).
  Cada paso es un objeto `{ id, labelKey, points, check, hint }`; si `check(frame, det)` devuelve `true`, ese paso cuenta como cumplido.
- **Cambiar los umbrales de decisión**: edita las constantes que hay al principio de cada ejercicio en `src/exercises.js`; todas llevan comentarios en chino:
  - `SQUAT_FRONT` (en `src/steps.js`): umbrales de profundidad de la sentadilla en vista frontal — `standRatio` 0.86 / `enterRatio` 0.72 /
  `bottomRatio` 0.25 (cuanto menor, más estricto) / `looseRatio` 0.45; la unidad es «cuánto más alta está la cadera que la rodilla ÷ longitud de la pantorrilla»; de pie ≈ 1.0;
  - `LUNGE.backKneeDrop`: altura de la rodilla de atrás respecto al suelo / longitud de la pantorrilla (por defecto 0.35; cuanto menor, más estricto);
  - `PUSHUP.elbowFull`: ángulo del codo en la parte baja de la flexión (por defecto 92°);
  - `BRIDGE.upRise` / `BRIDGE_HOLD.holdRise`: altura a la que se sube la cadera en el puente de glúteos (en unidades de longitud del torso);
  - `PLANK.bodyStraight`: ángulo mínimo para considerar que el cuerpo está en línea recta en la plancha (por defecto 158°);
  - `HoldDetector.graceMs`: margen de tolerancia de los ejercicios de cronómetro (por defecto 1200ms).

Cuando termines, ejecuta `npm test`: las pruebas ya incluyen la amplitud estándar de estos ejercicios, así que te dirán al momento si te has pasado.

**Cómo funciona el reconocimiento**: todos los criterios usan solo **ángulos** y **proporciones respecto a la longitud del torso**, así que no dependen de tu altura ni de la distancia a la que esté la cámara;
los puntos clave se corrigen antes según la relación de aspecto del encuadre y luego se calculan los ángulos, con un filtro One Euro para reducir el temblor. Por eso los mismos umbrales sirven para personas y colocaciones distintas.

---

## Privacidad y licencia

- La imagen se procesa solo en el navegador de tu propio equipo: **no se sube nada**. El modelo y el wasm son archivos locales, así que funcionan sin internet.
- El servidor, por defecto, solo escucha en `127.0.0.1`: nadie más de la misma red puede acceder.
- El historial de entrenamientos se guarda únicamente en el localStorage de tu navegador.
- Recursos de terceros: MediaPipe Tasks Vision (wasm) y el modelo Pose Landmarker que están en `vendor/` son de Google MediaPipe y siguen la **Apache License 2.0**.
