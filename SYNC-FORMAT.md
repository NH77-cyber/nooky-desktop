# Format du dossier de synchronisation de Nooky — version 2

C'est le **contrat commun** entre l'encoche (Nooky Desktop, Mac et PC), la « maison » web sur
claude.ai et les tâches planifiées. Il remplace la version 1 et reste compatible avec elle.

Dossier partagé : `<Google Drive>/Nooky/` (Google Drive pour ordinateur côté encoche,
connecteur Google Drive côté claude.ai).

> **Contrainte clé** : le connecteur Google Drive de claude.ai sait **créer** un fichier et le
> **mettre à la corbeille**, mais **pas réécrire son contenu**. Côté claude.ai, toute écriture
> est donc la création d'un nouveau fichier (et éventuellement la mise à la corbeille
> d'anciens). Côté encoche (fichiers locaux), on peut réécrire son propre fichier.

Règles générales :

- Tous les JSON sont en UTF-8.
- Un lecteur **ignore** tout fichier illisible ou partiel (Drive est peut-être encore en train de
  le télécharger) et **réessaie au tour suivant**.
- Un lecteur ignore les copies de conflit de Drive pour les journaux d'opérations (leur nom ne
  correspond pas au motif, voir §1). Pour les briefs et le courrier, voir §2 et §3.
- Personne n'écrit jamais le fichier d'un autre.

---

## 0. Le dossier

```
<Google Drive>/Nooky/
├── ops-macbook-pro-k3f9x2ab.json        ← journal de l'encoche du Mac (réécrit par lui seul)
├── ops-pc-bureau-7t2mq0zd.json          ← journal de l'encoche du PC
├── ops-maison-1791190000000.json        ← un lot d'opérations de la maison (un fichier par lot)
├── ops-task-veille-1791190500000.json   ← un lot d'une tâche planifiée
├── brief-morning.json                   ← brief « Ce matin » (tâche planifiée)
├── brief-veille.json …                  ← autres briefs (§2)
├── mail-m-2026-10-05-1.json             ← un message (§3)
├── ask-macbook-pro-k3f9x2ab-1791190800000.json     ← question du chat gratuit (§4)
└── answer-macbook-pro-k3f9x2ab-1791190800000.json  ← réponse de la maison (§4)
```

Emplacement détecté automatiquement par Nooky Desktop :

| Système | Chemin cherché |
|---|---|
| macOS | `~/Library/CloudStorage/GoogleDrive-*/Mon Drive/Nooky` (ou `My Drive`) ; à défaut `/Volumes/GoogleDrive/Mon Drive/Nooky` |
| Windows | `G:\Mon Drive\Nooky` (ou `My Drive`), puis les autres lettres de lecteur |

Le dossier `Nooky` est créé s'il n'existe pas. Un autre dossier peut être choisi dans les
Réglages. Sans Google Drive, Nooky fonctionne en **mode local** (un dossier `sync` dans les
données de l'application) : tout marche, mais sur cet appareil seulement.

## 1. Journal d'opérations — `ops-<writer>.json` et `ops-<writer>-<ts>.json`

### Noms de fichiers

Seuls les fichiers dont le nom correspond exactement à

```
^ops-[A-Za-z0-9_-]+\.json$
```

sont lus — **tous**, quel que soit leur nombre. Le reste est ignoré, en particulier les copies
de conflit de Drive (`ops-pc-bureau (1).json`), les fichiers temporaires
(`.ops-x.json.tmp-123`) et les sauvegardes (`ops-x.json.corrupt-1700000000`).

Chaque écrivain n'écrit **que ses propres fichiers** :

- **Encoche** : un seul fichier, `ops-<deviceId>.json`, réécrit de façon atomique (fichier
  temporaire dont le nom ne correspond pas au motif, vidé sur disque, puis renommé), et
  compacté au-delà de **2 000 opérations** (dernière opération par (coll, key, champ) ; une
  opération qui gagne encore un champ garde son `id` et son `ts`).
  `deviceId` : `[A-Za-z0-9_-]`, 64 caractères au plus, créé au premier lancement (nom de la
  machine + `-` + 8 caractères aléatoires) et gardé dans `device.json` (données de l'app).
- **Maison / tâches planifiées** : un **nouveau fichier par lot**,
  `ops-maison-<epochms>.json`, `ops-task-<nom>-<epochms>.json`.
  Compactage côté maison : au-delà de **40** fichiers `ops-maison-*`, en créer un consolidé
  (dernière opération par (coll, key, champ)) puis mettre les anciens à la corbeille.

### Contenu

```json
{
  "version": 2,
  "writer": "macbook-pro-k3f9x2ab",
  "device": "MacBook Pro",
  "ops": [
    { "id": "5b7e0c1e-2f4a-4c8e-9d61-0f2b1a7c9e33", "ts": 1791096120000,
      "coll": "tasks", "key": "tmg3k2a1b9xq", "task": "tmg3k2a1b9xq",
      "set": { "title": "Relancer le client", "tiroir": "pro", "day": "2026-10-05",
               "origDay": "2026-10-05", "time": "14:00", "done": false, "doneAt": null,
               "createdAt": "2026-10-04T08:02:00.000Z" } },
    { "id": "c0a8e1d2-77b3-4f0e-8a51-3e9d2c4b6f10", "ts": 1791178440000,
      "coll": "shopping", "key": "smg3k9", "set": { "label": "Lait", "done": false, "doneAt": null } }
  ]
}
```

| Champ du fichier | Sens |
|---|---|
| `version` | `2` (un fichier v1 a `1` et pas de `writer` : il est lu de la même façon) |
| `writer` | identifiant de l'écrivain (`deviceId`, `maison-…`, `task-…`) |
| `device` | nom lisible de l'appareil (information seulement, facultatif) |
| `ops` | les opérations, ajoutées à la fin |

| Champ d'une opération | Sens |
|---|---|
| `id` | texte non vide, unique (UUID v4 conseillé) |
| `ts` | moment de l'opération, en **millisecondes depuis le 1er janvier 1970 (UTC)** |
| `coll` | collection (voir plus bas) ; **absent = `"tasks"`** |
| `key` | clé de l'élément dans sa collection ; **absente = `task`** |
| `task` | (v1) clé d'une tâche. Nooky Desktop l'écrit **aussi** sur les opérations de `tasks` (`task = key`) pour que les encoches encore en v1 continuent de voir les tâches. |
| `set` | objet : les champs que l'opération fixe |

**Compatibilité v1** : une opération sans `coll` est `coll: "tasks"` avec `key = op.task`.

Créer = une opération avec tous les champs ; modifier = seulement les champs changés ;
supprimer = `"set": { "deleted": true }`. Les champs inconnus sont conservés par le pliage et
ignorés par l'affichage.

### Calculer l'état (« plier »)

1. Lire tous les fichiers qui correspondent au motif ; ignorer ceux qui ne se lisent pas.
2. Ignorer toute opération mal formée (`id` non texte, `ts` non nombre, ni `key` ni `task`
   texte, `coll` présent mais pas un texte non vide, `set` absent ou pas un objet) et les `id`
   déjà vus.
3. Trier **toutes** les opérations de **tous** les fichiers par `ts` croissant puis, à `ts`
   égal, par `id` (comparaison de chaînes simple).
4. Pour chaque opération dans cet ordre, recopier chaque champ de `set` dans l'élément
   (`coll`, `key`) : **le dernier écrivain gagne, champ par champ**.
5. `deleted: true` masque l'élément. Une tâche sans `title` (modification arrivée avant sa
   création) n'est pas affichée.

> L'ordre repose sur les horloges des appareils : gardez l'heure automatique activée partout.

### Les collections

**`tasks`** — `{title, tiroir: "pro"|"perso", day: "YYYY-MM-DD", origDay, time: "HH:MM"|null,
done, doneAt, createdAt, deleted}` (+ `routine` sur une occurrence de routine, voir plus bas).

- **Report** : une tâche non faite avec `day < aujourd'hui` s'affiche aujourd'hui, avec
  l'étiquette « reportée d'hier » / « reportée depuis N jours » calculée depuis le plus ancien
  de `origDay` et `day`. C'est une **règle d'affichage** : rien n'est écrit.
- Ordre de « Ma journée » : avec heure (par heure), puis reportées (la plus ancienne d'abord),
  puis routines, puis le reste (par `createdAt`).
- Actions de l'encoche : Ajouter (tous les champs, `origDay = day`) ; Cocher
  `{done: true, doneAt}` ; Décocher `{done: false, doneAt: null}` ; « Demain » `{day}` (garde
  `origDay`) ; « Dans 30 min » `{day, time}` ; « Retirer » `{deleted: true}`.

**`routines`** (récurrences) — `{title, tiroir, rule: {freq: "daily"|"weekly"|"monthly",
days: [1-7] (ISO, 1 = lundi) pour weekly, monthDay: 1-31 pour monthly, workdaysOnly: bool},
time: "HH:MM"|null, kind: "task"|"sac", active: bool, deleted}`.

- `monthDay` plus grand que le mois (31 en novembre) = le dernier jour du mois.
  `workdaysOnly` = pas le samedi ni le dimanche.
- `kind: "task"` : chaque jour concerné, l'occurrence apparaît comme une **tâche virtuelle** de
  clé `r_<routineKey>_<YYYYMMDD>`. La cocher écrit dans `tasks`, clé
  `r_<routineKey>_<YYYYMMDD>` : `{title, tiroir, day, origDay: day, time, done: true, doneAt,
  createdAt, routine: "<routineKey>"}`. « Pas aujourd'hui » écrit `{deleted: true}` sur cette
  clé. Une occurrence non faite **n'est pas reportée**.
- `kind: "sac"` : les choses à préparer **la veille au soir** pour le lendemain (« Sac de
  demain »). Affichées à partir de **17 h** pour les occurrences du lendemain, cochables de la
  même façon (clé `r_<routineKey>_<YYYYMMDD du lendemain>`). L'encoche envoie un rappel doux à
  **19 h 30** s'il reste des cases non cochées.

**`subs`** (abonnements) — `{name, price: nombre (€), cycle: "monthly"|"yearly",
nextRenewal: "YYYY-MM-DD", trialEnd: "YYYY-MM-DD"|null, category: "jeux"|"streaming"|"autre",
deleted}`. Rappel **3 jours avant** `nextRenewal` et avant `trialEnd`. Total mensuel affiché
= mensuels + annuels / 12. (Affichage : un `nextRenewal` passé est avancé d'un cycle à la fois
jusqu'à aujourd'hui ; rien n'est écrit.)

**`watch`** (à suivre) — `{title, kind: "jeu"|"serie"|"film", platform: texte, note: texte,
deleted}` : liste d'envies (jeux en promo, séries suivies) utilisée par le brief loisirs.

**`shopping`** (courses) — `{label, done, doneAt, deleted}`. « Vider les cochés » écrit
`{deleted: true}` sur chaque article coché.

**`events`** (agenda famille / perso) — `{title, date: "YYYY-MM-DD", time|null,
kind: "ecole"|"anniv"|"rdv"|"autre", remindDaysBefore: nombre, deleted}`. L'encoche affiche les
14 prochains jours et rappelle l'événement `remindDaysBefore` jours avant (une fois par appareil).

**`prefs`** (clé unique `main`) — `{prenom, proHours: {days: [1-5], start: "08:30",
end: "18:30"}, platforms: ["PS5", …], streaming: ["Netflix", …], schoolZone: "A"|"B"|"C",
eveningRecap: "18:00"}`. Écrit par les Réglages de l'encoche (un champ modifié = une opération
avec ce champ seulement) et lu par la maison et les tâches planifiées.

**`mailread`** — clé = `id` d'un message (§3), `{read: true}`.

## 2. Briefs — `brief-<slot>.json`

Écrits par les tâches planifiées : un **nouveau fichier**, puis l'ancien de même slot à la
corbeille. S'il y a plusieurs fichiers pour un même slot, on prend celui dont `updatedAt` est
le **plus récent**.

`slot` ∈ `veille` (Daily Prog, 8 h), `morning` (8 h 40), `evening` (18 h), `weekly`
(vendredi), `monthly` (début de mois), `leisure` (jeudi soir).

```json
{"slot":"morning","updatedAt":"2026-10-05T06:40:00.000Z","updatedLabel":"lundi 5 octobre, 8 h 40","title":"Ta journée",
 "text":"markdown simple : **gras** et puces « - »",
 "items":[{"title":"…","url":"https://…","meta":"AdExchanger · 2 oct."}],
 "mails":[{"from":"…","subject":"…","url":"https://mail.google.com/…"}]}
```

Lecture côté encoche : tous les fichiers `brief-<nom>.json` (y compris les doublons de Drive
`brief-morning (1).json`, puisque le choix se fait sur le contenu) ; le slot vient du champ
`slot`, à défaut du nom du fichier. `text` : `**gras**`, puces `- `, titres `# `, liens
`[texte](https://…)`. Seuls les liens `http(s)` sont ouverts (dans le navigateur).
Un ancien `brief.json` (v1) est encore lu comme brief `morning` s'il est plus récent.

Dans l'île : onglet **Briefs** avec un sous-onglet par slot présent (Ce matin, Veille, Ce soir,
Semaine, Mois, Loisirs) ; l'accueil montre une ligne du brief le plus récent ; le bilan du soir
montre le brief `evening`.

## 3. Courrier — `mail-<id>.json`

```json
{"id":"m-2026-10-05-1","at":"2026-10-05T06:10:00.000Z","from":"Daily Prog","title":"…","body":"…","important":true}
```

Un fichier par message (doublons de Drive dédupliqués par `id`). Lu / non lu via la collection
`mailread`. Les lecteurs n'affichent que les **30 derniers jours**. L'encoche notifie tout de
suite un message `important` non lu (même pendant une séance de concentration). Un ancien
`mailbox.json` (v1) est encore lu (ses messages `read: true` comptent comme lus).

## 4. Chat gratuit via la maison

Sans clé API, l'encoche passe les questions à la maison :

- L'encoche crée `ask-<deviceId>-<epochms>.json` :
  `{"id":"<deviceId>-<epochms>","at":"ISO","device":"…","tiroir":"pro","text":"question",
  "history":[{"role":"user|assistant","content":"…"}]}` (6 derniers tours au plus).
- La maison (si elle est ouverte) liste les `ask-*.json` sans réponse, répond avec Claude et
  crée `answer-<id>.json` : `{"id":"…","at":"ISO","text":"réponse markdown"}`.
- L'encoche affiche « Nooky transmet ta question à la maison… » puis la réponse quand
  `answer-<id>.json` apparaît. Après **3 minutes** sans réponse : « La maison est fermée :
  ouvre-la pour que je puisse te répondre (ou ajoute une clé API). » (Si la réponse arrive
  plus tard, elle s'affiche quand même.)
- L'encoche supprime **ses** `ask-<deviceId>-*` / `answer-<deviceId>-*` de plus de **7 jours**
  (fichiers locaux), au démarrage puis toutes les 6 heures.
- Fichiers déposés sur l'île : sans clé, seul le **texte** d'un fichier texte de **20 Ko au
  plus** part dans la question ; les PDF et images demandent une clé API.

## 5. Mode pro / perso automatique

Calculé **localement** depuis `prefs.main.proHours` (par défaut lun–ven 08:30–18:30) : pro
pendant ces heures, perso sinon. Bascule manuelle possible (pastille en haut de l'île), valable
**jusqu'au prochain changement de plage horaire**, gardée sur l'appareil seulement. Couleur
d'accent : pro = ambre `#f1b45c`, perso = menthe `#6fd6b4`. « Ma journée » montre le mode en
cours par défaut (« tout voir » pour les deux) ; une nouvelle tâche prend le mode en cours.

## 6. Ce qui reste sur chaque appareil (jamais dans le dossier partagé)

Les rappels déjà montrés (clé `"<task>@<day>T<time>"`, `sub:<key>@<date>`, `ev:<key>@<date>`,
`sac@<date>`, `recap@<date>`), les messages déjà notifiés, les briefs déjà vus, la bascule
manuelle pro / perso. Le Mac et le PC ne se marchent ainsi jamais dessus.
