# Fitness en mouvement · Motion Fitness Game

[中文](README.md) · [English](README.en.md) · [Español](README.es.md) · [Français](README.fr.md)

Un mini-jeu de fitness qui détecte tes mouvements avec une simple webcam : **comptage automatique des squats / fentes / pompes / ponts fessiers**,
**chrono automatique pour la planche / le pont fessier statique**, et surtout un **score attribué étape par étape selon les « étapes techniques »** :
chaque étape validée rapporte aussitôt des points, déclenche un bip et annonce l'étape à voix haute.

L'interface existe en **quatre langues : 中文 / English / Español / Français**, que tu peux changer à tout moment en haut à droite de la page.

Tout est côté client : le modèle de posture MediaPipe et le wasm sont stockés en local dans le dossier `vendor/`, **aucune connexion réseau, aucune image envoyée**.

---

## Table des matières

- [Points forts](#points-forts)
- [Prérequis](#prérequis)
- [Installation](#installation)
  - [Étape 0 : récupérer le code](#étape-0--récupérer-le-code)
  - [Étape 1 : installer Node.js](#étape-1--installer-nodejs)
  - [Installer Node.js sous Windows](#installer-nodejs-sous-windows)
  - [Installer Node.js sous macOS](#installer-nodejs-sous-macos)
  - [Installer Node.js sous Linux](#installer-nodejs-sous-linux)
  - [Pas envie d'installer Node.js ? Utilise Python](#pas-envie-dinstaller-nodejs--utilise-python)
- [Démarrage et accès](#démarrage-et-accès)
- [Réglages des autorisations caméra](#réglages-des-autorisations-caméra)
- [Calibrage avant la séance](#calibrage-avant-la-séance)
- [Comment jouer (le cadrage est essentiel)](#comment-jouer-le-cadrage-est-essentiel)
- [Règles de score](#règles-de-score)
- [Langues](#langues)
- [Calibrage bloqué ou rien ne se passe ? Diagnostic en quatre étapes](#calibrage-bloqué-ou-rien-ne-se-passe--diagnostic-en-quatre-étapes)
- [Questions fréquentes](#questions-fréquentes)
- [Tests](#tests)
- [Structure du projet](#structure-du-projet)
- [Ajuster les points / les seuils toi-même](#ajuster-les-points--les-seuils-toi-même)
- [Confidentialité et licence](#confidentialité-et-licence)

---

## Points forts

- **Calibrage avant la séance** : avant de commencer, une **silhouette en pointillés** s'affiche dans l'image (elle n'esquisse que le contour extérieur,
  rien à aligner sur un squelette) et une ligne de texte en haut de l'image t'indique « place-toi dans la silhouette en pointillés » ;
  l'identification du corps, le corps entier dans l'image, la distance, le centrage, la hauteur, l'angle de vue et l'immobilité —
  **sept critères** à valider tous ensemble avant que le comptage démarre, pour éviter de « t'entraîner dans le vide » quand tu es mal placé.
- **Un score attribué étape par étape selon les étapes techniques** : chaque exercice est découpé en 4 à 6 étapes vérifiables ; chaque étape réussie
  rapporte aussitôt des points, déclenche un bip et coche la ligne ; valider toutes les étapes d'une série donne droit à un bonus de série parfaite ;
  pour les exercices chronométrés, **chaque seconde tenue rapporte +1 point**.
- **Un comptage qui ne retient que le travail valide** : une répétition partielle, trop rapide, avec le bas du dos qui s'affaisse ou les fesses relevées
  n'est pas comptée comme valide ; elle est comptabilisée à part et assortie d'un conseil de correction.
- **Un retour d'état en temps réel** : sous l'image, tu vois en permanence « dans quel état tu es, à quelle étape tu bloques et combien de degrés il te reste ».
- **🐞 Panneau « Métriques »** : affiche d'un clic tous les chiffres bruts que voit le détecteur (vue, visibilité, angles des articulations) — un problème de cadrage se repère au premier coup d'œil.
- **Annonce vocale en chinois + effets sonores** : chaque étape validée est saluée par une gamme montante, la première réussite d'une étape est annoncée à voix haute, et le score est annoncé tous les 50 points.
- **🦴 Interrupteur du squelette** : permet de masquer le squelette pour ne garder que l'image de la caméra ; les annotations d'angles s'activent séparément.
- **Anneau de progression vers l'objectif, meilleur score et historique d'entraînement** (conservés en local dans le navigateur).
- **Fonctionne hors ligne** : le modèle et le wasm sont en local, tout marche même sans connexion ; aucune image n'est envoyée.

---

## Prérequis

| Élément | Exigence |
|---|---|
| Système d'exploitation | Windows 10/11, macOS 11+, n'importe quelle distribution Linux grand public avec environnement de bureau |
| Navigateur | Chrome / Edge 91+, Safari 16.4+, Firefox 89+ (WebAssembly SIMD requis) |
| Caméra | Webcam intégrée d'ordinateur portable ou caméra USB, 720p ou plus recommandé |
| Node.js | **Facultatif**. Le `preview-server.js` fourni demande Node 18+ ; si tu ne veux pas installer Node, Python fait aussi l'affaire |
| Réseau | **Nécessaire uniquement pour récupérer le code** ; l'exécution et la détection se font entièrement hors ligne |

---

## Installation

### Étape 0 : récupérer le code

**Méthode A : télécharger le ZIP (recommandé si git te rebute)**

1. Ouvre <https://github.com/playteka/motion-fitness-game>
2. Clique sur le bouton vert **Code** → **Download ZIP**
3. Décompresse l'archive où tu veux, par exemple `C:\Users\TonNom\motion-fitness-game` (Windows) ou `~/motion-fitness-game` (macOS / Linux)

**Méthode B : cloner avec git**

```bash
git clone https://github.com/playteka/motion-fitness-game.git
cd motion-fitness-game
```

> Le dépôt contient déjà le wasm et le modèle de posture MediaPipe (environ 33 Mo) : **aucune** étape d'installation de dépendances n'est nécessaire, il n'y a pas de `npm install`.

### Étape 1 : installer Node.js

Node sert uniquement à lancer le petit serveur statique local fourni (une quinzaine de lignes). **Si tu l'as déjà installé, passe à la suite** ; vérifie avec `node -v` :

```bash
node -v      # version 18 ou plus récente requise ; v20/v22 conviennent aussi
```

---

### Installer Node.js sous Windows

**Méthode 1 : winget (intégré à Windows 10 1809+ / Windows 11, le plus simple)**

Ouvre **PowerShell** (cherche « PowerShell » dans le menu Démarrer) et exécute :

```powershell
winget install OpenJS.NodeJS.LTS
```

**Méthode 2 : l'installeur officiel**

1. Ouvre <https://nodejs.org/> → télécharge le **Windows Installer (.msi)** 64 bits en version **LTS**
2. Double-clique pour installer et enchaîne les Next ; **garde impérativement l'option « Add to PATH » cochée par défaut**
3. Une fois l'installation terminée, **ferme puis rouvre** PowerShell / l'invite de commandes

**Vérification :**

```powershell
node -v
npm -v
```

Si les deux commandes affichent un numéro de version (par exemple `v22.14.0` / `10.9.2`), c'est gagné.

> Si un message du type « node n'est pas reconnu comme cmdlet » apparaît, c'est que le PATH n'est pas actif : ferme le terminal et rouvre-le ; si ça persiste, réinstalle Node en vérifiant que « Add to PATH » est bien coché.

---

### Installer Node.js sous macOS

**Méthode 1 : Homebrew (recommandé)**

Si Homebrew n'est pas encore installé, exécute d'abord dans le Terminal la commande indiquée sur le site officiel (<https://brew.sh>) :

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Ensuite :

```bash
brew install node
```

**Méthode 2 : l'installeur officiel**

1. Ouvre <https://nodejs.org/> → télécharge le **macOS Installer (.pkg)** en version **LTS**
2. Double-clique et suis l'assistant jusqu'au bout
3. Ouvre le **Terminal** pour vérifier

**Vérification :**

```bash
node -v
npm -v
```

> Les puces Apple (série M) comme les puces Intel fonctionnent avec l'installeur universel du site officiel ; Homebrew installe automatiquement la version correspondant à ton architecture.

---

### Installer Node.js sous Linux

**Debian / Ubuntu / Linux Mint**

Les versions présentes dans les dépôts système sont souvent anciennes : passe plutôt par le dépôt LTS de NodeSource :

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

**Méthode universelle : nvm (fonctionne sur toutes les distributions, sans sudo)**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# rouvre le terminal, ou lance d'abord : source ~/.bashrc
nvm install --lts
```

**Vérification :**

```bash
node -v
npm -v
```

> **Autorisation caméra (spécifique à Linux)** : vérifie que le périphérique existe et que tu as les droits de lecture et d'écriture
> ```bash
> ls -l /dev/video*
> ```
> Si le périphérique appartient à `root:video`, ajoute-toi au groupe video puis **reconnecte-toi** :
> ```bash
> sudo usermod -aG video $USER
> ```
> Dans le navigateur, la caméra fonctionne normalement sous `http://127.0.0.1` (localhost est considéré comme un contexte sécurisé) : aucune configuration supplémentaire n'est nécessaire.

---

### Pas envie d'installer Node.js ? Utilise Python

Ce projet n'est au fond qu'une **page web statique** : n'importe quel serveur statique fait l'affaire. macOS et la plupart des distributions Linux embarquent Python 3 :

```bash
cd motion-fitness-game
python3 -m http.server 4174 --bind 127.0.0.1
```

Sous Windows, si Python est installé, remplace `python3` par `python` :

```powershell
cd motion-fitness-game
python -m http.server 4174 --bind 127.0.0.1
```

> ⚠️ Il faut **Python 3.9 ou plus récent** : les versions plus anciennes ne renvoient pas le bon type `application/wasm` pour les fichiers `.wasm`,
> et le navigateur refusera de charger le modèle de posture. Si tu n'as pas de Python récent, Node reste la solution la plus simple.

---

## Démarrage et accès

**Avec Node (recommandé) :**

```bash
cd motion-fitness-game
node preview-server.js
```

Tu devrais voir ces deux lignes (le script en imprime une en chinois et une en anglais) :

```
体感健身游戏预览地址： http://127.0.0.1:4174
Motion Fitness is running at: http://127.0.0.1:4174
```

**Avec Python :** voir la section précédente ; on accède là aussi au port 4174.

Ouvre ensuite cette adresse dans ton navigateur :

### 👉 <http://127.0.0.1:4174>

À la première ouverture, clique sur « Activer la caméra » → choisis « Autoriser » dans la fenêtre du navigateur → choisis un exercice → **place-toi dans la silhouette en pointillés** ;
une fois le calibrage validé, clique sur « Démarrer la séance » pour lancer le comptage.

> ⚠️ **N'ouvre surtout pas `index.html` en double-cliquant dessus.** Ouverte en `file://`, la page verra le navigateur bloquer la caméra et le chargement du wasm :
> il faut passer par `http://127.0.0.1:...` (localhost est considéré par le navigateur comme un contexte sécurisé).

**Changer de port / autoriser l'accès depuis un autre appareil**

```bash
# Windows PowerShell
$env:PORT=8080; node preview-server.js

# macOS / Linux
PORT=8080 node preview-server.js
```

Par défaut, le serveur n'écoute que sur `127.0.0.1` (accessible uniquement depuis cette machine) : c'est à la fois une protection de ta vie privée et une façon d'éviter que quelqu'un d'autre sur le même réseau ne s'y connecte.

---

## Réglages des autorisations caméra

### Windows

1. **Paramètres → Confidentialité et sécurité → Caméra**
   - Active « **Accès à la caméra** »
   - Active « **Autoriser les applications à accéder à ta caméra** »
   - Plus bas, trouve « **Autoriser les applications de bureau à accéder à ta caméra** » et vérifie que c'est bien activé
2. Dans le navigateur, clique sur l'icône 🔒 / caméra à gauche de la barre d'adresse → passe « Caméra » sur **Autoriser**, puis recharge la page
3. Au premier lancement de `node`, le pare-feu Windows peut afficher une alerte : comme le serveur n'écoute que sur 127.0.0.1, **autoriser ou annuler ne change rien à l'utilisation**

### macOS

1. La première fois que tu cliques sur « Activer la caméra », le navigateur affiche la fenêtre d'autorisation du système → clique sur « **Autoriser** »
2. Si tu as refusé par erreur : **Réglages Système → Confidentialité et sécurité → Caméra** → coche le navigateur que tu utilises (Chrome / Safari / Edge), puis **quitte complètement le navigateur et relance-le**
3. Utilisateurs de Safari : Safari exige d'autoriser le site courant dans « Réglages → Sites web → Caméra »

### Linux

1. Vérifie que `/dev/video*` existe et que tu as les droits (voir la section « Installer Node.js sous Linux » ci-dessus)
2. Dans le navigateur, clique sur l'icône à gauche de la barre d'adresse → autorise la caméra
3. Si tu utilises un navigateur en version Flatpak / Snap, il faut peut-être autoriser le périphérique caméra dans les réglages du système ou via `flatpak override --device=all`

---

## Calibrage avant la séance

Une fois ton exercice choisi, une **silhouette en pointillés** apparaît dans l'image : une ligne de contour extérieur nette (et non un squelette articulé), c'est ta cible de posture ;
une ligne de texte s'affiche aussi en haut de l'image et te dit directement « entre dans la silhouette en pointillés ». Le panneau de calibrage coche les critères un par un :

| Critère | Signification |
|---|---|
| Corps détecté | La caméra te voit bien |
| Corps entier | De la tête aux pieds, tout est dans l'image |
| Bonne distance | Ta taille dans l'image est la bonne (trop loin / trop près : le panneau te dit dans quel sens bouger) |
| Bien centré | Ton corps se trouve au milieu de la silhouette |
| Bonne hauteur | Ta position verticale dans l'image est la bonne |
| Bon angle | Le squat se filme **de face**, les autres exercices **de profil** |
| Immobile | Reste sans bouger environ 1 seconde, pour éviter une validation pendant que tu bouges |

**Chacun des six exercices a sa propre silhouette** : il suffit de te mettre en position et de suivre le contour — le squat est une posture debout de face, la fente une posture debout de profil,
la pompe une **position haute de pompe, vue de profil** (bras tendus, mains au sol), la planche une **position allongée de profil sur les avant-bras** (sur les avant-bras, corps au ras du sol),
et le pont fessier comme le pont fessier statique une **position allongée de profil, jambes fléchies** (allongé sur le dos, genoux fléchis, pieds à plat au sol, bassin posé au sol).
De profil, le contour se retourne automatiquement de gauche à droite selon ton orientation.

Une fois les sept critères validés et tenus un court instant, la silhouette devient verte et le message « Calibrage terminé ✓ » s'affiche : c'est seulement à ce moment que le bouton « Démarrer la séance » devient actif.
Clique dessus (ou appuie sur Espace) → décompte 3-2-1 → le comptage démarre.

> Si tu n'es pas bien placé, la ligne de texte en haut de l'image et le panneau de calibrage t'indiquent tous les deux directement quoi faire (par exemple « recule un peu », « décale-toi vers la droite », « mets-toi face à la caméra »),
> tu ne resteras jamais sans savoir ce qui ne va pas.
> Pour les exercices allongés (pompe / planche / pont fessier), la distance se juge d'après la **longueur du corps** : pas besoin de te lever.
> Pour refaire le calibrage : clique sur « Recalibrer » sous l'image ; chaque fin de série te ramène aussi automatiquement au calibrage.

---

## Comment jouer (le cadrage est essentiel)

**Le squat se filme de face, les cinq autres exercices de profil** :

- **Squat** : face à la caméra. La flexion du genou se fait dans l'axe « avant-arrière » : de profil, cet axe tombe pile sur l'axe horizontal de l'image, donc il se mesure très bien —
  mais **seul un cadrage de face permet de voir si les genoux rentrent vers l'intérieur**, et de vérifier la symétrie gauche-droite ; le squat se filme donc de face.
  La profondeur se juge sur « de combien les hanches dépassent les genoux », une grandeur que la vue de face n'écrase pas, et qui est même plus directe que l'angle du genou.

- Place-toi à **2–3 m** de la caméra et fais entrer **tout ton corps** dans l'image (de la tête aux pieds) ;
- **Fente** : debout de profil face à la caméra, avec chevilles, genoux, hanches et épaules visibles en même temps ;
- **Pompe / planche** : le corps allongé ou à plat perpendiculaire à l'objectif, mains et pieds dans le cadre ;
- **Pont fessier / pont fessier statique** : allongé de profil, avec épaules, hanches, genoux et chevilles visibles en même temps ;
- Éclairage homogène, arrière-plan pas trop chargé, et vêtements plutôt ajustés : la détection sera plus stable.

**À noter : l'analyse démarre dès l'instant où tu choisis un exercice ; inutile de cliquer d'abord sur « Démarrer la séance ».**
Le comptage, lui, ne démarre qu'une fois que tu es bien placé dans la silhouette et que le calibrage est validé.

**Raccourcis clavier** : `1`~`6` changer d'exercice · `Espace` démarrer/pause · `R` réinitialiser le compteur · `Esc` terminer la série · `M` miroir · `S` squelette · `F` plein écran sur la vidéo

---

## Règles de score

À droite de l'interface se trouve une **liste des étapes techniques** : chaque étape réussie est aussitôt cochée, rapporte des points et déclenche un bip ;
l'étape à faire maintenant est surlignée. **Valider toutes les étapes de la série** donne un bonus supplémentaire de série parfaite ; pour les exercices
chronométrés, **chaque seconde tenue rapporte 1 point de plus**.

### Squat (45 points par série au maximum)

Le squat se filme **de face** ; la profondeur se juge sur le rapport « écart de hauteur entre hanches et genoux / longueur du tibia » (debout ≈ 1,0 ; cuisses à l'horizontale ≈ 0) :

| Étape technique | Condition de validation | Points |
|---|---|---|
| ① Mets-toi face à la caméra, tout le corps dans l'image et bien droit | Vue de face + corps entier visible + corps bien vertical + hanches nettement plus hautes que les genoux (rapport > 0,86) | +4 |
| ② Plie les genoux et descends, hanches vers le bas | Rapport d'écart de hauteur ≤ 0,72 (cuisses à environ 46° de l'horizontale) | +6 |
| ③ Plie les genoux dans l'axe des pieds | Rapport ≤ 0,50 (environ 30°) | +7 |
| ④ **Descends jusqu'à ce que les cuisses soient presque horizontales** | Rapport ≤ 0,25 (cuisses à 15° de l'horizontale au plus, ou plus bas) | **+14** |
| ⑤ Pousse dans le sol et redresse-toi, hanches et genoux tendus | Rapport revenu à ≥ 0,80 | +8 |
| 🎁 Toutes les étapes de la série validées | Les 5 étapes ci-dessus validées dans la même série | +6 |

### Fente (54 points par série au maximum)

| Étape technique | Condition de validation | Points |
|---|---|---|
| ① Mets-toi de profil face à la caméra, corps droit et entier dans l'image | Vue de profil + corps entier visible + corps droit + jambes presque tendues | +4 |
| ② Avance une jambe : un pied devant, un pied derrière | Écart avant-arrière entre les chevilles > 0,45 fois la longueur du tronc | +5 |
| ③ Fais un grand pas (écarte bien les pieds) | Écart avant-arrière entre les chevilles > 0,9 fois la longueur du tronc | +6 |
| ④ Plie les deux genoux en descendant, genou avant à 90° | La jambe la plus pliée ≤ 118° et l'autre ≤ 150° | +11 |
| ⑤ **Descends le genou arrière près du sol** | Hauteur du genou arrière au-dessus du sol ≤ 0,35 fois la longueur du tibia | **+14** |
| ⑥ Pousse sur le pied avant pour revenir debout | Les deux jambes se retendent (après être descendu) | +8 |
| 🎁 Toutes les étapes de la série validées | Les 6 étapes ci-dessus validées dans la même série | +6 |

### Pompe (40 points par série au maximum)

| Étape technique | Condition de validation | Points |
|---|---|---|
| ① Mains au sol, corps bien aligné | Position sur les mains + alignement du corps ≥ 165° + sans affaissement du bas du dos ni fesses relevées | +5 |
| ② Serre les abdos et descends en pliant les coudes | Angle du coude ≤ 140° | +7 |
| ③ **Coudes pliés à 90° ou moins** | Angle du coude ≤ 95° et corps toujours bien aligné | **+14** |
| ④ Pousse pour remonter, bras complètement tendus | Angle du coude ≥ 145° (après être descendu) | +8 |
| 🎁 Toutes les étapes de la série validées | Les 4 étapes ci-dessus validées dans la même série | +6 |

### Pont fessier (39 points par série au maximum)

| Étape technique | Condition de validation | Points |
|---|---|---|
| ① Sur le dos, genoux pliés, pieds bien à plat à la largeur des hanches | Position allongée sur le dos, genoux pliés (épaules au sol, genoux décollés) | +5 |
| ② Serre les fessiers et pousse les hanches vers le haut | Élévation des hanches > 0,15 fois la longueur du tronc | +6 |
| ③ **Monte jusqu'à aligner épaules, hanches et genoux** | Élévation des hanches > 0,35 fois la longueur du tronc | **+14** |
| ④ Redescends les fesses au sol avec contrôle | Retour au sol (après être monté) | +8 |
| 🎁 Toutes les étapes de la série validées | Les 4 étapes ci-dessus validées dans la même série | +6 |

### Planche (70 points par série + 1 point par seconde)

| Étape technique | Condition de validation | Points |
|---|---|---|
| ① Avant-bras sous les épaules, décolle le corps du sol | Épaules décollées + mains au sol + angle du coude valide | +8 |
| ② Tête, dos, hanches et chevilles alignés | Alignement du corps ≥ 158° + sans affaissement du bas du dos ni fesses relevées | +12 |
| ③ Tiens la position 3 secondes | Position tenue 3 secondes complètes | +10 |
| ④ Tiens la position 10 secondes | Position tenue 10 secondes complètes | +15 |
| ⑤ Tiens la position 30 secondes | Position tenue 30 secondes complètes | +25 |
| ⏱ Chaque seconde tenue | Tant que la position reste valide | +1/seconde |

### Pont fessier statique (63 points par série + 1 point par seconde)

| Étape technique | Condition de validation | Points |
|---|---|---|
| ① Sur le dos, genoux pliés, pieds bien à plat à la largeur des hanches | Position allongée sur le dos, genoux pliés | +6 |
| ② Monte les hanches au plus haut | Élévation des hanches > 0,32 fois la longueur du tronc | +12 |
| ③ Fessiers serrés, tiens 3 secondes | Position tenue 3 secondes complètes | +10 |
| ④ Tiens 10 secondes | Position tenue 10 secondes complètes | +15 |
| ⑤ Tiens 20 secondes | Position tenue 20 secondes complètes | +20 |
| ⏱ Chaque seconde tenue | Tant que la position reste valide | +1/seconde |

### Sons et retours vocaux

| Moment | Retour |
|---|---|
| Une étape technique validée | **Un bip en gamme montante** + une animation `+12` qui s'échappe de l'image |
| Toutes les étapes de la série validées | Accord ascendant de trois notes « sans faute » + animation de points |
| Première réussite d'une étape | **L'étape est annoncée à voix haute** ; ensuite, seul le bip retentit, pour éviter le bavardage |
| Tous les 50 points | Bip montant + annonce vocale du score + sous-titre de félicitations |
| Une répétition valide de plus | Son de comptage sur cinq notes + annonce vocale du nombre |
| Une répétition non comptée | « Pouf » grave + un sous-titre qui pointe le problème |
| Pendant un maintien chronométré | Un petit clic chaque seconde + un score qui grimpe en continu |
| Objectif atteint / fin de série | Accord de célébration + animation « objectif atteint » + bilan de la série (score et étapes manquées) |

Les effets sonores comme les annonces vocales se désactivent d'un clic dans la barre du haut.

---

## Langues

L'interface intègre quatre langues ; la liste **Langue** en haut à droite permet de basculer à tout moment, et ton choix est mémorisé :

| Langue | Code | Fichier de libellés |
|---|---|---|
| 中文 | `zh` | `src/locales/zh.js` |
| English | `en` | `src/locales/en.js` |
| Español | `es` | `src/locales/es.js` |
| Français | `fr` | `src/locales/fr.js` |

À la première ouverture, la langue est choisie automatiquement d'après celle de ton navigateur (chinois / anglais / espagnol / français ; les autres langues retombent sur l'anglais).

**Ajouter une langue** : copie `src/locales/en.js`, adapte-le à la nouvelle langue, importe-le dans `src/i18n.js` et ajoute-le à `LOCALES`,
puis relance `npm run test:i18n` — le test vérifie une par une les clés manquantes, les traductions oubliées, les espaces réservés et la longueur des tableaux, pour que rien ne passe à la trappe.

---

## Calibrage bloqué ou rien ne se passe ? Diagnostic en quatre étapes

**① Vérifie d'abord la version.** À côté du titre de la page doit s'afficher `v1.5`. Si tu ne la vois pas, ton navigateur utilise encore l'ancienne version en cache — force le rechargement avec **Ctrl + F5** (sur Mac : Cmd + Shift + R).

**② Regarde d'abord le panneau « Calibrage avant la séance » à droite.** Le critère qui reste décoché te dit quoi faire, juste en dessous :

| Message du panneau | Signification |
|---|---|
| On ne voit pas tout ton corps : recule un peu… | Le modèle ne te trouve pas, ou une partie du corps sort du cadre |
| Tu es trop loin de la caméra : avance un peu / trop près : recule un peu | Ta taille dans l'image n'est pas la bonne |
| Décale-toi vers la droite / vers la gauche pour te mettre au centre de la silhouette | Tu n'es pas centré |
| Décale-toi vers le haut / vers le bas de l'image | Ta position verticale n'est pas la bonne |
| Mets-toi face à la caméra / Mets-toi de profil face à la caméra | Le cadrage ne correspond pas à l'exercice choisi |
| Bonne position, ne bouge pas… | Il ne manque plus qu'une seconde |

**③ Regarde ensuite la barre d'état sous l'image** : elle affiche le même message ; une fois la séance lancée, elle indique quelle est l'étape suivante et ce qu'il reste à faire.

**④ Ouvre « 🐞 Métriques » en haut à droite** (utilisable pendant le calibrage comme pendant la séance). Les chiffres que voit le détecteur s'affichent en temps réel sous l'image, par exemple :

```
Vue Profil ✓(0.18) · Corps entier ✓ · Jambes visibles ✓ · Inclinaison du torse 6° · Genou 176° · Coude 172° ·
Hanche 172° · Alignement du corps 175° · Élévation des hanches -0.98 · Angle cuisse-horizontale 88° · Visibilité 0.94 · État running
```

À comparer avec ce tableau :

| Symptôme | Cause | À faire |
|---|---|---|
| `Vue Profil ✗(0.90)` | Le cadrage ne correspond pas à l'exercice choisi (le squat se filme de face, les autres de profil) | Tourne-toi comme l'indique la barre d'état : de face pour le squat, de profil pour les autres |
| `Corps entier ✗` | Une partie de ton corps sort du cadre | Recule d'1 à 2 pas pour que tout, de la tête aux pieds, entre dans l'image |
| `Aucun corps détecté` | Trop loin / trop près, contre-jour, arrière-plan de la même couleur que tes vêtements | Rapproche-toi, mets-toi face à la source de lumière, change de vêtements, essaie une caméra de meilleure résolution |
| `Inclinaison du torse` durablement > 32° | La caméra est penchée, ou tu te tiens de travers | Remets la caméra droite (cale-la avec un livre) |
| Les chiffres sont bons mais aucune coche n'apparaît | Tu bloques sur le seuil d'une étape | La barre d'état indique directement ce qu'il manque (par exemple « tu es déjà à 62 % (100 % = cuisses à l'horizontale) ») |

---

## Questions fréquentes

**Q : Que faire si le port 4174 est déjà occupé ?**
Lance simplement le serveur sur un autre port : `PORT=8080 node preview-server.js` (sous Windows : `$env:PORT=8080; node preview-server.js`).
Pour savoir qui occupe le port : `lsof -i :4174` sous macOS/Linux ; `netstat -ano | findstr 4174` sous Windows.

**Q : Le navigateur affiche « caméra indisponible / NotAllowedError » ?**
Active les deux niveaux d'autorisation (système et navigateur) comme expliqué dans « Réglages des autorisations caméra », puis **quitte complètement le navigateur et relance-le**.

**Q : La page affiche « Échec du chargement du modèle de posture » ?**
C'est le plus souvent un type MIME incorrect pour les fichiers `.wasm`. Le plus fiable est d'utiliser le `node preview-server.js` fourni ; avec Python, il faut la version 3.9+.
Vérifie aussi que le dossier `vendor/` est complet (c'est l'erreur la plus fréquente quand on télécharge le ZIP depuis GitHub : le dossier entier n'est pas toujours décompressé).

**Q : L'image saccade / le débit d'images est faible ?**
Dans la barre du haut, passe **Modèle** sur **Léger** ; désactive « 📐 Angles » ; essaie un appareil plus puissant. La détection reste parfaitement utilisable entre 10 et 15 FPS.

**Q : Est-ce que ça marche sur téléphone ?**
Oui. Ouvre simplement la même adresse dans le navigateur du téléphone (le téléphone et l'ordinateur doivent être sur le même réseau local, et le serveur doit écouter sur `0.0.0.0` :
remplace `'127.0.0.1'` par `'0.0.0.0'` dans `preview-server.js`, puis redémarre). Attention : n'importe qui sur le même réseau pourra alors y accéder.

**Q : Où sont stockées les données ?**
L'historique d'entraînement et les meilleurs scores sont stockés dans le localStorage de ton navigateur : changer de navigateur ou vider le cache les efface, et rien n'est jamais envoyé à un serveur.

---

## Tests

```bash
npm test                       # les quatre suites d'un coup (445 tests)
npm run test:i18n              # langues : clés manquantes / traductions oubliées / espaces réservés / longueur des tableaux / chinois résiduel dans les sources
npm run test:detectors         # détection et logique de score (squelettes synthétiques)
npm run test:dump              # affiche en plus les métriques de posture de référence, pour régler les seuils
npm run test:page              # auto-contrôle du câblage de la page (id DOM / imports de modules / ressources statiques)
npm run test:app               # test d'intégration : charge le vrai app.js avec un stub DOM minimal
```

| Fichier de test | Nombre de tests | Contenu couvert |
|---|---|---|
| `tests/test-i18n.mjs` | 32 | Structure de clés identique dans les quatre langues, aucune traduction manquante, espaces réservés et longueurs de tableaux identiques, aucun texte chinois codé en dur dans les sources, structure identique des quatre README |
| `tests/test-detectors.mjs` | 192 | Comptage, chronométrage, points par étape et ordre de validation, pour les mouvements corrects comme pour toutes sortes de mouvements erronés, ainsi que la logique de validation du calibrage |
| `tests/test-page.mjs` | 97 | Câblage du DOM, imports et exports de modules, ressources statiques, exhaustivité du barème |
| `tests/test-app.mjs` | 124 | Démarrage du vrai `app.js`, déroulé du calibrage, changement d'exercice, score, sons, bilan, interrupteur du squelette, changement de langue |

---

## Structure du projet

```
motion-fitness-game/
├─ index.html            structure de la page (les textes passent par data-i18n)
├─ style.css             styles de l'interface sombre
├─ preview-server.js     serveur local sans dépendance (http://127.0.0.1:4174)
├─ src/
│  ├─ i18n.js            ★ cœur multilingue (t / setLang / applyI18n)
│  ├─ locales/           ★ zh.js / en.js / es.js / fr.js, les quatre jeux de libellés
│  ├─ geometry.js        géométrie et traitement du signal (angles, lissage One Euro)
│  ├─ metrics.js         métriques par image (angles articulaires, élévation des hanches, alignement du corps…)
│  ├─ steps.js           ★ « étapes techniques » notées de chaque exercice (condition + points + clé d'indice)
│  ├─ calibration.js     ★ calibrage avant la séance : contour de la silhouette en pointillés + sept critères de placement
│  ├─ exercises.js       ★ machines à états et moteur de score des six exercices
│  ├─ pose-engine.js     enveloppe MediaPipe PoseLandmarker + gestion de la caméra
│  ├─ render.js          tracé du squelette
│  ├─ audio.js           effets sonores + annonces vocales (suivent la langue)
│  └─ app.js             interface, déroulé de la séance, liste des étapes, historique, boucle principale
├─ tests/                quatre suites de tests automatisés
└─ vendor/               MediaPipe tasks-vision (wasm) et modèle de posture (hors ligne)
```

---

## Ajuster les points / les seuils toi-même

- **Modifier les points ou le texte des étapes** : édite `src/steps.js` (structure et points) et `src/locales/*.js` (textes).
  Chaque étape est un objet `{ id, labelKey, points, check, hint }` ; quand `check(frame, det)` renvoie `true`, l'étape est considérée comme validée.
- **Modifier les seuils de validation** : édite les constantes en haut de chaque exercice dans `src/exercises.js` — elles sont toutes commentées en chinois :
  - `SQUAT_FRONT` (dans `src/steps.js`) : les seuils de profondeur du squat filmé de face — `standRatio` 0,86 / `enterRatio` 0,72 /
  `bottomRatio` 0,25 (plus la valeur est petite, plus c'est strict) / `looseRatio` 0,45 ; l'unité est « écart de hauteur hanches-genoux ÷ longueur du tibia », debout ≈ 1,0 ;
  - `LUNGE.backKneeDrop` : hauteur du genou arrière au-dessus du sol / longueur du tibia (0,35 par défaut, plus la valeur est petite, plus c'est strict) ;
  - `PUSHUP.elbowFull` : angle du coude en bas de la pompe (92° par défaut) ;
  - `BRIDGE.upRise` / `BRIDGE_HOLD.holdRise` : hauteur d'élévation des hanches pour le pont fessier (en unités de longueur de tronc) ;
  - `PLANK.bodyStraight` : angle minimum d'alignement du corps pour la planche (158° par défaut) ;
  - `HoldDetector.graceMs` : délai de tolérance des exercices chronométrés (1200 ms par défaut).

Après tes modifications, lance `npm test` : les tests connaissent déjà l'amplitude standard de ces mouvements et te diront tout de suite si tu es allé trop loin.

**Principe de la détection** : tous les critères reposent uniquement sur des **angles** et sur des **proportions rapportées à la longueur du tronc**, indépendantes de ta taille comme de la distance à la caméra ;
les points clés sont d'abord corrigés selon le rapport largeur/hauteur de l'image avant le calcul des angles, puis un filtre One Euro atténue les tremblements : les mêmes seuils s'adaptent donc à des personnes et à des cadrages différents.

---

## Confidentialité et licence

- Les images sont traitées uniquement dans ton navigateur, **aucun envoi** ; le modèle et le wasm sont des fichiers locaux, utilisables hors ligne.
- Par défaut, le serveur n'écoute que sur `127.0.0.1` : personne d'autre sur le même réseau ne peut y accéder.
- L'historique d'entraînement reste dans le localStorage de ton navigateur.
- Ressources tierces : MediaPipe Tasks Vision (wasm) et le modèle Pose Landmarker présents dans `vendor/` viennent de Google MediaPipe et sont distribués sous **Apache License 2.0**.
