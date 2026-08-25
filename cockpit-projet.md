# Cockpit — plan de contrôle du cycle de développement

> Nom de code provisoire. À trancher avant le premier commit public.

**Une fenêtre qui connaît l'état complet du travail en cours, et depuis laquelle on déclenche tout le reste.**

---

## 1. Le problème

Le travail sur une fonctionnalité n'est pas une branche. C'est une branche **×** N repos **×** un backend **×** des serveurs dev **×** une base de données **×** un domaine local **×** un ticket **×** une PR **×** une CI **×** parfois un ou plusieurs agents.

Cet objet n'existe nulle part aujourd'hui. Il est réparti entre des dossiers sur le disque, des process dans des onglets de terminal, des configurations locales, des outils web — et surtout **la tête du développeur**.

Trois coûts mesurables :

- **Reprise** — revenir sur un sujet après trois jours coûte 10 à 20 minutes de reconstruction mentale avant la première ligne utile.
- **Parallélisme** — travailler sur deux sujets à la fois multiplie ce coût au lieu de l'amortir.
- **Dérive** — l'état réel des environnements s'écarte silencieusement de ce qu'on croit.

Et un quatrième, propre au travail avec des agents : **la conversation est le seul endroit où vit la compréhension**. Donc on n'ose pas la vider, donc le contexte pourrit, donc l'agent dérive, donc la qualité chute. Voir §6.

Le coût n'est pas dans les outils. Il est dans le **switch** entre eux, et dans **l'absence de mémoire** entre les sessions.

## 2. Ce que c'est — et ce que ce n'est pas

**C'est** un cockpit : il **affiche l'état** et **déclenche l'action**, même quand l'exécution part ailleurs.

**Ce n'est pas** :

| Pas un… | Parce que |
|---|---|
| IDE | Voir, naviguer, corriger : oui. Complétion, navigation sémantique, débogueur : non. Le cockpit ouvre l'IDE au bon endroit. |
| client Git complet | Il expose les opérations quotidiennes avec un filet de sécurité, en gardant le vocabulaire de Git. Il ne cache pas Git. |
| gestionnaire de tickets | Lire, changer un statut, lier une PR. Rien de plus. |
| navigateur | Il ouvre l'aperçu de la feature. Il ne remplace ni les devtools ni le profil connecté. |
| terminal | Il en embarque un, indispensable comme porte de sortie. Il ne remplace pas le shell configuré. |
| générateur de projets | Voir §11 — c'est un autre produit. |
| plateforme d'environnements éphémères | Voir §10, ligne rouge L5. |

La formule qui tranche les arbitrages : **le cockpit supprime la navigation, pas les outils.**

## 3. Principes directeurs

1. **Le noyau ne connaît presque rien.** Un workspace, un événement, une capacité. Tout le reste est optionnel. C'est ce qui rend le système à la fois clair et flexible (§5).
2. **Le noyau est un outil en ligne de commande ; l'interface n'est qu'un client.** Tout doit être faisable sans elle.
3. **Tout est un événement.** Un journal unique dont dérivent l'affichage, les logs, les automations et l'historique. Structurant, très difficile à rajouter après coup.
4. **On sonde, on ne se souvient pas.** Rien de ce que Git, Docker ou le système savent déjà n'est stocké. Sinon la première suppression manuelle rend tout l'affichage mensonger.
5. **Le cockpit lit l'organisation, il ne la dicte pas.** Chaque projet déclare sa stratégie ; le cockpit s'adapte.
6. **Une seule action à la fois sur un même sous-arbre.** Verrouillage par chemin, pas par feature (§7).
7. **Toute opération affiche son plan avant de s'exécuter** et laisse une trace annulable.
8. **Rien ne se décide à la place du développeur.** Pas de merge auto, pas de push auto, pas de commit d'agent sans revue.
9. **Absent = invisible, jamais grisé.** Une capacité non configurée ne laisse aucune trace dans l'interface.

## 4. Concepts

### Workspace — le primitif

**Un endroit où du travail se passe.** Un chemin, éventuellement un repo, éventuellement une branche, éventuellement un runtime.

| Type | Exemple |
|---|---|
| `main` | le checkout principal d'un repo |
| `worktree` | un checkout isolé pour une branche |
| `group` | un dossier contenant plusieurs des précédents |
| `external` | un dossier quelconque, un scratch, un clone manuel |

Le checkout principal est un workspace **de plein droit**, pas un cas dégradé. C'est là que la majorité du travail se passe réellement.

### Feature — une décoration, pas un conteneur

**Un nom + un ensemble de workspaces**, plus éventuellement un ticket, une PR, un environnement, une mémoire.

Elle peut regrouper zéro, un ou N workspaces. Et surtout : **un workspace peut n'appartenir à aucune feature.** C'est le cas normal, pas l'exception.

```
Workspace ────┐   le primitif
              │
 Feature ─────┤
 Ticket ──────┤   décorent un ou N workspaces
 Runtime ─────┤
 Agent ───────┘
```

### Niveaux de cérémonie

Chaque action choisit son niveau. Le manifest ne déclare que le **défaut** du projet.

| | Niveau | Ce qui est créé |
|---|---|---|
| **C0** | *yolo* | rien — on pointe un dossier et on lance |
| **C1** | branche | une branche dans le checkout existant |
| **C2** | isolé | un worktree |
| **C3** | feature | worktrees + environnement + base + ticket + mémoire |

Un mono-repo simple tournera en C0/C1 en permanence. Un projet multi-repo en C3 pour le travail planifié, en C0 pour « je regarde ce bug vite fait ».

**Le cockpit doit rendre C0 aussi rapide qu'un terminal**, sinon il ne sera pas utilisé dans l'urgence — et c'est précisément là qu'un filet de sécurité sert le plus.

On peut toujours **monter** de niveau après coup : « ce yolo devient sérieux » → un bouton crée la branche, puis le worktree, puis l'environnement, sans perdre le travail en cours. On ne descend jamais.

### Ce qui tient à tous les niveaux

Le mode yolo relâche la *structure*, jamais la *traçabilité* :

1. **Le journal enregistre** — quel agent, où, quand, combien.
2. **Le diff reste visible et marqué humain / agent.**
3. **Le verrou existe** — deux agents sur le même sous-arbre, jamais.
4. **Un point de restauration est capturé** avant toute écriture d'agent. En C0 on est sur le checkout principal : c'est là qu'on a le plus à perdre.

**Un yolo tracé** — c'est la valeur ajoutée par rapport à un terminal nu.

### Autres termes

**Runtime** — la façon dont l'environnement d'exécution est fourni (§8).
**Capacité** — un module optionnel qui s'enregistre auprès du noyau (§5).
**Manifest** — fichier versionné décrivant le projet. Source de vérité de l'état désiré.
**Journal** — le flux d'événements, append-only.
**Mémoire** — la compréhension durable d'une feature, séparée des sessions (§6).

## 5. Le modèle de capacités

C'est ce qui permet à un seul outil de servir un mono-repo sans tickets **et** un multi-repo complet, sans que le premier ressemble au second amputé.

Le noyau connaît trois choses : un **workspace**, un **événement**, une **capacité**. Tout le reste s'enregistre.

| Capacité | Absente | Présente — implémentations |
|---|---|---|
| `vcs` | *(toujours présente)* | git |
| `tickets` | pas d'onglet, pas de colonne | GitHub Issues, Jira, Bitbucket, Linear… |
| `review` | pas d'onglet PR, pas de badge | GitHub, Bitbucket… |
| `ci` | pas de badge | Actions, Pipelines… |
| `runtime` | pas de bouton serveur ni d'aperçu | Herd, Compose, devcontainer, Expo, distant |
| `agents` | pas d'onglet agent | claude, codex, plusieurs en parallèle |
| `docs` | rien | dossier local, repo séparé |
| `memory` | pas d'onglet mémoire | fichiers dans le workspace |

**Règle d'interface non négociable : absent = invisible.** Un projet mono-repo sans tickets, sans agents, en C0 doit ressembler à un outil simple — pas à un outil complexe avec huit boutons désactivés. C'est la différence entre *flexible* et *usine à gaz configurable*.

**Défaut sain : sans manifest, le cockpit fonctionne quand même.** Il détecte ce qu'il peut (`.git`, `compose.yaml`, `app.json`, un dossier `docs/`) et propose. Le manifest ne sert qu'à ce qui n'est pas devinable.

**Test à appliquer à toute idée future :** *puis-je l'exprimer comme une capacité que le noyau ignore ?* Si non, on alourdit le noyau — et c'est là que ce genre de projet meurt.

## 6. La mémoire de feature

Le manque le plus important, et celui qu'aucun outil ne traite. Trois couches **distinctes** — les confondre est l'erreur à éviter.

| Couche | Contenu | Durée de vie | Écrite par |
|---|---|---|---|
| **Mémoire** | décisions, compréhension, contraintes, pistes écartées | toute la feature | l'humain + les agents, explicitement |
| **Sessions** | historique de conversation d'un agent | jetable, à volonté | le moteur d'agent |
| **Journal** | ce qui s'est passé (commandes, diffs, événements) | toute la feature | le cockpit, automatiquement |

**Pourquoi c'est capital.** Aujourd'hui, vider une session détruit la compréhension. Donc on ne le fait pas. Donc le contexte se dégrade, l'agent dérive, et la qualité du code chute — le mécanisme exact qui produit une masse de code médiocre.

Avec la séparation, **vider devient gratuit** : la conversation part, la mémoire reste, la session suivante démarre en la lisant.

### Organisation

```
<workspace ou feature>/.cockpit/
  memory.md       ← durable, éditable à la main, lue par les agents
  journal.jsonl   ← automatique, append-only
  sessions/       ← jetables, listables, comparables
```

### Structure de la mémoire

```markdown
## Objectif
## Décisions        (ce qui a été tranché, et pourquoi)
## Contraintes      (ce qu'il ne faut pas casser)
## Écarté           ← la section la plus précieuse
## État             (où on en est)
```

La section **Écarté** est celle que personne n'écrit et qui vaut le plus : sans elle, chaque session fraîche repropose la solution déjà rejetée pour une bonne raison, et le débat recommence.

### Deux mécanismes indispensables

- **Promotion.** Dans une session, sélectionner un passage → « promouvoir en mémoire ». Si écrire la mémoire est un effort séparé, elle ne sera jamais écrite.
- **Sessions comparables.** Deux sessions sur la même mémoire, deux diffs, on choisit. Permet aussi de lancer deux moteurs différents sur le même problème et de comparer.

### Sortie de cycle

À la clôture d'une feature, la mémoire ne meurt pas : le cockpit propose de **promouvoir vers la documentation** (§9). Les décisions durables quittent le cycle de vie de la feature et deviennent de la connaissance projet.

## 7. Les agents

Une session d'agent = **une liste de chemins** + un moteur + un mode + un bail. Pas « une feature ».

| Besoin | Portée |
|---|---|
| Agent sur tout le projet | les N chemins de repos |
| Agent sur un repo | 1 chemin |
| Agent sur un sous-dossier | 1 sous-chemin |
| Yolo sur le checkout principal | le chemin du main |
| Agent sur un dossier sans dépôt Git | 1 chemin, aucun repo |

### Verrouillage par chemin

Une session prend un **bail** sur un ensemble de sous-arbres. Le cockpit refuse toute session dont la portée chevauche un bail actif. Un agent projet et un agent repo sur le même sujet ne peuvent pas coexister — ils s'écraseraient, et la corruption serait silencieuse.

Le verrou porte sur des **chemins**, jamais sur des features : ça fonctionne identiquement en C3 structuré et en C0 yolo.

### Contexte pour l'agent projet

Un agent qui embrasse plusieurs repos a besoin d'un fichier d'instructions à la racine du groupe, expliquant la relation entre eux : qui appelle qui, quelles conventions d'API, quoi ne pas toucher. **Sans ce fichier, un agent multi-repo est plus dangereux qu'utile.**

### Contraintes permanentes

Répertoire de travail confiné à la portée déclarée. Liste blanche de commandes. **Jamais de push. Jamais sur la branche principale.** Revue de diff humaine obligatoire avant tout commit. Coût affiché par session.

### Multi-moteurs

`claude` et `codex` sont deux implémentations de la même capacité. Chacun expose un mode non interactif à sortie structurée et une reprise de session ; le cockpit normalise les deux flux en un seul type d'événement et affiche la même interface. Le choix du moteur se fait au lancement, pas au niveau du projet.

## 8. Le contrat de runtime

Le cockpit ne cherche pas à unifier les runtimes dans un schéma commun — ce serait réinventer Compose, en pire. Il unifie **les questions qu'il pose**, pas les réponses.

| Verbe | Question |
|---|---|
| `provision` | prépare l'environnement de ce workspace |
| `preview` | comment j'y accède (URL, simulateur, QR code, ou rien) |
| `exec` | lance une commande dedans |
| `logs` | flux de sortie |
| `db` | reset, dump, restore *(si applicable)* |
| `health` | est-ce que ça répond |
| `teardown` | efface tout |

Deux propriétés déclarées par chaque runtime :

- **`portable`** — le workspace peut-il tourner ailleurs que sur cette machine ? Un runtime non portable l'affiche explicitement et voit les actions distantes masquées, avec la raison.
- **`exclusive`** — plusieurs workspaces de ce runtime peuvent-ils tourner simultanément ? Si non, le cockpit propose de basculer plutôt que de démarrer.

Le manifest déclare le runtime et un bloc de configuration **propre à ce runtime**, pas un schéma universel :

```yaml
runtime: herd
herd:
  tld: test
  db: { engine: mysql, strategy: clone-per-feature }
```

## 9. Documentation et connaissance

Capacité `docs` : un chemin (dossier dans le repo ou repo séparé), indexé en recherche plein texte, rendu en Markdown dans le panneau contexte.

Son intérêt réel est le **couplage avec la mémoire** :

- **En entrée** — les agents lisent la documentation pertinente. Contexte réutilisable au lieu d'être réexpliqué à chaque session.
- **En sortie** — à la clôture d'une feature, promotion de la mémoire vers la documentation.

C'est ce qui fait qu'un wiki reste vivant. Un wiki alimenté séparément meurt en trois mois, toujours. Un wiki alimenté par le résidu naturel du travail survit.

## 10. Portabilité

Trois axes indépendants, souvent confondus, aux coûts très différents.

| | Question | Ce qui la résout | Quand |
|---|---|---|---|
| **A. Runtime** | le projet tourne-t-il ailleurs ? | conteneurs / devcontainer | par projet, au fil de l'eau |
| **B. Workspace** | mon état de travail se reconstruit-il ailleurs ? | manifest + noyau CLI versionnés | tôt, peu coûteux |
| **C. Localisation** | le cockpit peut-il tourner ailleurs que la charge ? | découplage interface ↔ noyau | **dès le départ, ou jamais** |

**Ne pas inventer de format.** Le standard existe : `devcontainer.json` + un fichier Compose, utilisable hors de tout IDE. Il donne gratuitement le cockpit, l'IDE de n'importe quel collègue et l'exécution serveur.

### Conteneurs et worktrees : quatre pièges non évidents

- **Le `.git` d'un worktree est un fichier, pas un dossier.** Monter seulement le dossier du worktree casse Git à l'intérieur. Le plus simple : décider que Git ne s'exécute jamais dans le conteneur.
- **Les dépendances installées ne doivent pas être des montages liés.** I/O lentes à travers la frontière, binaires natifs non portables. Volume nommé par workspace — la duplication disque devient purgeable d'un geste.
- **La surveillance de fichiers traverse mal la frontière.** Les événements ne remontent pas toujours ; le rechargement à chaud meurt en silence. À vérifier **avant** de construire dessus.
- **Un conteneur par workspace, une base par workspace, mais un seul serveur de base de données.** L'isolation vient du nom de la base, pas du conteneur.

### L'échelle, et la ligne rouge

| | Niveau | Effort | Gain |
|---|---|---|---|
| L0 | machine unique, configuration manuelle | — | *(situation actuelle)* |
| L1 | manifest + noyau CLI versionnés | ~1 semaine | une autre machine démarre en 30 min |
| L2 | projets containerisés | par projet | n'importe quel OS, n'importe quel collègue |
| L3 | interface ↔ noyau découplés | ~2 jours **si fait dès le départ** | l'exécution distante devient possible |
| L4 | exécution sur serveur de dev | 2 à 4 semaines | machine locale déchargée, environnements partageables |
| L5 | environnements éphémères par feature sur serveur | ∞ | **ligne rouge — c'est de la plateforme, un autre métier** |

**Ordre : L3 dès maintenant, L1 dans la foulée, L2 au fil de l'eau, L4 contre une raison précise uniquement.**

**Test de portabilité :** machine vierge, trois commandes, état de travail retrouvé. Sinon, on a de la documentation, pas de la portabilité.

### Ce qui casse en distant — à assumer

Latence de frappe (confortable à 30 ms, insupportable à 120 ms). L'IDE, qui exige du développement distant. L'aperçu, qui demande du port-forwarding ou un domaine wildcard — donc de l'authentification si le serveur est exposé. Les fichiers hors Git, plus ouvrables directement. Le partage de ressources, qui devient une infrastructure à dimensionner et surveiller.

Le compromis qui évite l'essentiel : **noyau distant, code synchronisé localement.** IDE et gestionnaire de fichiers restent locaux, l'exécution part sur le serveur.

## 11. Contraintes de conception — pas des fonctionnalités

Ces deux sujets **ne sont pas au périmètre**. Ils figurent ici pour que l'architecture ne les rende pas impossibles.

### Mobile (Expo)

Hypothèse posée : le mobile signifiera **Expo / React Native**, pas du Swift ou du Kotlin natif. Ça change presque tout, et dans le bon sens.

**Ce qui passe sans effort** — c'est-à-dire l'essentiel du cockpit : Git, worktrees, tickets, agents, mémoire, documentation, diff, journal. Un projet Expo est un projet Node avec un serveur de développement. Le modèle s'applique tel quel.

**Ce qui demande une adaptation mineure** :

| Sujet | Traitement |
|---|---|
| Aperçu | Le verbe `preview` retourne l'URL du bundler **et** un QR code. Déjà couvert par la généralisation du verbe (§8). |
| Port par défaut | Le bundler Expo écoute sur 8081 — collision directe avec les plages de ports d'autres projets. L'allocation doit être déterministe et unique **à travers tous les projets**, pas seulement au sein d'un projet. À intégrer dès la conception de l'allocation. |
| Parallélisme | Plusieurs instances du bundler sur des ports différents coexistent sans problème. Le runtime Expo est `exclusive: false`. |
| Appareil physique | *Là* se trouve l'exclusivité : un appareil, un aperçu à la fois. C'est une contrainte sur l'appareil, pas sur le runtime — le cockpit signale le conflit sans bloquer les bundlers. |
| Builds natifs | Nécessaires seulement lors de l'ajout de dépendances natives. Plusieurs minutes, exécution distante. Le contrat de runtime les traite comme une commande longue avec suivi de progression — même mécanisme que les migrations. |

**Ce qui ne passe pas** : rien de structurel. La seule limite honnête est que si un jour du natif pur s'ajoute, la part du travail couverte par le cockpit diminue — l'essentiel se passera dans Xcode ou Android Studio. Acceptable, à condition de ne pas chercher à combler cet écart.

**Décision immédiate** : aucune, sauf **rendre l'allocation de ports globale plutôt que par projet.** Coût aujourd'hui : nul. Coût plus tard : une migration.

### Générateur de projets

**C'est un autre produit.** Raison d'être différente (créer vs piloter), cycle de vie différent (une fois vs en continu), complexité sans fond (la matrice stack × runtime × CI × conventions n'a pas de fin), et il existe déjà des générateurs dans chaque écosystème.

**Ce qu'on fait à la place, et qui coûte zéro** : s'assurer que **le manifest est écrivable à la main en cinq minutes**. Si c'est vrai, n'importe quel générateur — script, template, ou agent avec une bibliothèque de modèles — peut produire un projet compatible. Le besoin n'est pas de construire le générateur, mais que le format soit trivial à produire.

## 12. Interface

### Écran principal — 80 % du temps

```
┌──┬──────────────────────────────┬──────────────────────────────────────┐
│Cp│  ⌘K  chercher / agir         │  583-integrations                    │
│  │                              │  ─────────────────────────────────── │
│▪ │ ┌ 583-integrations     ⚡2   │  Code Diff(14) Agent Mémoire Ticket  │
│  │ │  ↑3 ↓0 · srv●●● · PR ✓     │                                      │
│▪ │ │  v2 · frontend · projects  │   v2         ↑3  ● cp-583.test       │
│  │ └                            │   frontend   ↑0  ● :8081             │
│▪ │                              │   projects   —   ○ non créé          │
│  │   master          ↑0 · srv●  │                                      │
│  │                              │   DB cashplannr_583 · 12 migrations  │
│＋│   ~/scratch/tva-poc  🤖claude│   Agent claude · idle · 4m · $0.42   │
│  │                              │                                      │
│  │ ── archivés (3) ─────────────│  [Rebase] [Merge] [PR] [Terminal]    │
└──┴──────────────────────────────┴──────────────────────────────────────┘
  projets      workspaces                    contexte
```

La liste centrale liste des **workspaces**, groupés par feature *quand* une feature existe. Un workspace nu et un groupe de trois cohabitent naturellement.

### Onglet Diff — la revue

```
┌── fichiers (14) ──┬─────────────────────────────────────────────┐
│ M app/Tva.php  +42│  - public function compute($amount)         │
│ M routes/api.php  │  + public function compute(Money $amount)   │
│ A tests/TvaTest   │    {                                        │
│ D old/Legacy.php  │  -     return $amount * 0.21;               │
│                   │  +     return $this->rate->applyTo($amount);│
│ ── par auteur ────│                                             │
│ ● humain     (6)  │                                             │
│ ◆ claude     (8)  │  [Ouvrir dans l'IDE]  [Commenter]           │
└───────────────────┴─────────────────────────────────────────────┘
```

La distinction **humain / agent** est le garde-fou principal : elle rend visible, donc contrôlable, la part de code jamais relue.

### Palette ⌘K — l'entrée réelle

```
┌─────────────────────────────────────────┐
│ 583                                     │
├─────────────────────────────────────────┤
│ → Aller à 583-integrations              │
│ ⚡ Démarrer les serveurs                 │
│ ⌥ Rebase sur master                     │
│ 🤖 Agent ici          ← C0, deux touches│
│ 📋 CP-583 · Intégrations comptables     │
│ ⌨  Terminal dans worktrees/v2/583       │
└─────────────────────────────────────────┘
```

L'objectif « 1 à 3 clics » est en réalité un objectif **zéro clic** : le clavier bat toujours la souris.

### Navigation dans le code — sans serveur de langage

Périmètre assumé : voir, naviguer, éditer manuellement. Pas de complétion, pas de navigation sémantique.

Ce qui remplace, et qui suffit :

- **Ouverture floue de fichier** sur les fichiers suivis par Git.
- **Recherche plein texte** — avec un atout qu'aucun IDE ne donne facilement : **recherche simultanée dans tous les repos d'une feature**. Chercher un nom de route dans le backend et deux fronts en une requête.
- **Références par convention** — cliquer sur un symbole lance une recherche de ce symbole. Approximatif, rapide, sans indexation.

Conséquence de design : **l'arbre de fichiers n'est pas la navigation principale.** Il sert à l'exploration occasionnelle ; le clavier fait le reste.

### Budget de clics — à tenir, pas à espérer

| Action | Budget |
|---|---|
| Passer d'un projet à un workspace, tout démarré | 1 |
| Voir le diff complet | 1 |
| Lancer un agent sur le workspace courant (C0) | 1 |
| Rebase | 2 (bouton → confirmation du plan) |
| Résoudre un conflit | 3 par fichier |

## 13. Architecture

```
┌───────────────────────────────────────────────────────┐
│  INTERFACE — cockpit                                   │
│  workspaces · code · diff · agents · mémoire · palette │
└──────────────── canal unique (local ou distant) ───────┘
┌───────────────────────────────────────────────────────┐
│  NOYAU — service permanent                             │
│  workspaces · événements · capacités                   │
│  réconciliateur · superviseur · baux · journal         │
└───────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────┐
│  CAPACITÉS (enregistrées, optionnelles)                │
│  vcs · tickets · review · ci · runtime · agents · docs │
└───────────────────────────────────────────────────────┘

  état désiré : le manifest, versionné
  état réel   : sondé en continu
```

**Trois règles qui découlent du schéma et ne se négocient pas :**

1. **L'interface n'a pas de système de fichiers.** Lire, lister, écrire, ouvrir un terminal : tout passe par le noyau. Sans cette discipline, l'exécution distante est une réécriture complète.
2. **Le noyau tourne en permanence**, indépendamment de l'interface — service système démarré au login, redémarré en cas de crash. Serveurs dev et agents survivent à la fermeture de la fenêtre.
3. **Le noyau doit pouvoir mourir et se reconstruire.** Au démarrage, il ne fait pas confiance à sa base : il sonde et se resynchronise. Il persiste le journal, pas l'état.

Quatre conséquences du service permanent, à traiter dès le premier palier : **poignée de main de version** entre interface et noyau ; **état « noyau injoignable » visible** dans l'interface avec relance ; **rotation des journaux** (un service permanent qui capture des logs de serveurs remplit un disque en quelques semaines) ; **nettoyage des process orphelins** au démarrage.

**Réconciliation plutôt que mutation.** Modèle Terraform : état désiré → sondage → différence → plan → application. Idempotent, rejouable, et fournit gratuitement un mode diagnostic qui répare au lieu de laisser deviner.

## 14. Stack technique

| Couche | Choix | Pourquoi |
|---|---|---|
| Langage | TypeScript partout | Un contrat typé partagé noyau ↔ interface |
| Interface | Electron + Quasar | Écosystème Node requis (PTY, watchers, SQLite) |
| Noyau | Process Node autonome, **pas** le process principal d'Electron | Imposé par le fonctionnement permanent |
| Transport | WebSocket local, schéma validé | Seule l'adresse change en distant |
| Code | CodeMirror 6 | Coloration, scroll, édition. Zéro machinerie de complétion |
| Recherche | ripgrep embarqué | C'est la navigation |
| Terminal | node-pty + xterm.js | Vrai TTY, requis par les interfaces d'agents |
| État | SQLite | Journal + cache, synchrone, sans serveur |
| Fichiers | chokidar | Avec exclusions agressives |
| Git | CLI en sous-process | Les worktrees sont mal couverts par les bindings |
| Agents | CLI en sous-process | Sortie structurée normalisée en un seul type d'événement |
| Manifest | YAML versionné | Lisible, commentable, diffable |
| Packaging | electron-builder + service système | launchd / systemd |

**Note d'honnêteté** : Node est le bon choix v1 (vitesse, écosystème complet). Go serait meilleur à terme — binaire unique, pas de runtime à installer sur un serveur. Garder la frontière noyau/interface propre permet de réécrire le noyau plus tard sans toucher à l'interface. Ne pas le faire maintenant.

## 15. Personnel maintenant, équipe un jour

Une seule règle, appliquée en permanence : **si un deuxième développeur en aurait besoin, ça vit dans le repo.**

| Dans le repo (versionné) | Sur la machine (local) |
|---|---|
| Le manifest | Quels workspaces existent |
| Les définitions de runtime | Les ports attribués |
| Les automations | Identifiants et jetons |
| Les instructions d'agents | État de l'interface, préférences |
| Le noyau CLI | Le journal local |
| La documentation | |
| **La mémoire de feature** | |

La mémoire est versionnée : c'est ce qui permet à un collègue de reprendre une feature en comprenant les décisions déjà prises.

**Conséquence principale : le noyau CLI doit être utilisable sans l'application.** Un collègue clone le repo, lance une commande, obtient un environnement complet — sans installer le cockpit. L'interface devient un confort personnel plutôt qu'une dépendance imposée.

Pour plus tard : quand ça devient collectif, c'est **un noyau par personne**, jamais un noyau partagé. Un noyau partagé implique authentification, permissions et isolation — ce serait construire une plateforme.

## 16. Garde-fous

**Opérations destructives.** Point de restauration capturé avant toute opération risquée. Bouton d'annulation alimenté par le reflog. Refus de démonter un workspace portant des commits non poussés. Sauvegarde de base avant suppression. Corbeille à durée de vie plutôt que suppression immédiate.

**Concurrence.** Baux par chemin. File d'exécution par dépôt pour les commandes Git. Vérification de la date de modification avant toute écriture — sans quoi une modification manuelle écrase silencieusement le travail d'un agent, ou l'inverse.

**Agents.** Portée confinée. Liste blanche de commandes. Jamais de push, jamais sur la branche principale. Revue humaine obligatoire. Coût affiché.

**Secrets.** Trousseau système, jamais en clair. Aucun environnement de process journalisé. En distant, les identités vivent côté serveur : décision de sécurité consciente, pas détail de plomberie.

**Process.** Registre persistant des process et ports. Nettoyage au démarrage. Arrêt par groupe.

**Ressources.** Le coût disque par workspace s'accumule en silence. Ramassage automatique des workspaces fusionnés, coût affiché à la création.

## 17. Trajectoire

Chaque palier doit être utilisable seul, et s'arrêter là doit rester acceptable.

| | Palier | Contenu | Gain |
|---|---|---|---|
| 1 | **Voir** | workspaces, état, lecture seule | savoir où on en est sans rien ouvrir — le gros du bénéfice |
| 2 | **Lancer** | IDE, terminal, aperçu, serveurs, agents C0 | les onglets de terminal disparaissent |
| 3 | **Mémoire** | mémoire, sessions, journal, diff humain/agent | vider une session devient gratuit |
| 4 | **Agir** | Git, features, cérémonies C2/C3, avec plan et annulation | le switch de contexte tombe à zéro |
| 5 | **Enchaîner** | automations, documentation, promotion | le travail répétitif s'efface |

Le palier 1 est atteignable en une semaine. **Le palier 3 est placé avant le palier 4 volontairement** : la mémoire apporte plus de valeur immédiate que l'automatisation de Git, et coûte beaucoup moins cher à rendre fiable.

Le palier 4 est celui où la fiabilité coûte cher — ne pas s'y engager tant que le 2 n'est pas solide. **Un outil Git en qui on n'a pas confiance est pire que pas d'outil.**

Le découplage interface ↔ noyau (§13) se fait **dès le palier 1**, même s'il ne sert à rien avant longtemps. Idem pour l'allocation globale des ports (§11).

## 18. Succès et échec

**Succès** — mesurable, pas ressenti :

- Reprendre un sujet après trois jours prend moins de 60 secondes.
- Vider une session d'agent ne coûte plus rien.
- Trois workspaces vivent en parallèle sans confusion.
- Aucun `cd` tapé à la main dans une journée normale.
- La part de diff jamais relue par un humain est visible.
- Une machine vierge est opérationnelle en trois commandes.

**Échec** — les signaux à surveiller :

- Le temps passé sur le cockpit dépasse le temps qu'il fait gagner.
- Une opération Git de l'interface a fait perdre du travail, et la confiance ne revient pas.
- L'outil est devenu indispensable **et** impossible à transmettre.
- Des fonctionnalités sont ajoutées parce qu'elles sont amusantes à construire.

## 19. Discipline et critère d'abandon

Le mandat professionnel est de stabiliser et améliorer le produit. Ce cockpit est un **outil au service de ce mandat**, pas le mandat. Or construire un outil neuf est nettement plus agréable que corriger du code existant : pas de dette, pas de contrainte, personne qui attend. Le risque n'est pas d'échouer à le construire — c'est de trop bien réussir, et de maintenir dans six mois un cockpit remarquable pour un produit qui n'a pas bougé.

Le critère d'abandon se décide **maintenant**, à froid, pour un soi futur trop investi pour juger.

**Budget.** _(à remplir)_ — par exemple : deux semaines pleines pour les paliers 1 à 3, puis un plafond hebdomadaire tenu sur un mois glissant.

**Seuil de continuation.** _(à remplir)_ — ce que chaque palier doit prouver pour passer au suivant. Par exemple : sans gain quotidien mesuré après le palier 2, gel au palier atteint et utilisation en l'état.

**Arrêt sec.** _(à remplir)_ — les signaux qui déclenchent l'arrêt sans négociation :
- une opération du cockpit a fait perdre du travail deux fois ;
- le temps de réparation dépasse le temps gagné ;
- une fonctionnalité a été ajoutée sans avoir été faite trois fois à la main.

**Règle permanente : ne rien automatiser avant de l'avoir fait trois fois manuellement.**

**Geler n'est pas échouer.** Un cockpit figé au palier 3, qui montre l'état, lance les serveurs et tient la mémoire des features, et qu'on ne touche plus — c'est une réussite complète. La plupart des outils internes meurent d'avoir continué, pas de s'être arrêtés.

## 20. Décisions tranchées

| Question | Réponse |
|---|---|
| Périmètre du code | Voir, naviguer, éditer manuellement. Aucune complétion ni navigation sémantique. |
| Portée des agents | Projet **et** repo **et** sous-dossier **et** dossier nu. Portée = liste de chemins + bail. |
| Personnel ou équipe | Personnel d'abord, équipe visée. Donc : tout ce qui est partageable vit dans le repo, dès maintenant. |
| Fonctionnement | Permanent. Service système, indépendant de l'interface. |
| Mobile | Expo uniquement. Hypothèse de conception, hors périmètre. |
| Générateur de projets | Hors périmètre. Contrainte : manifest écrivable à la main en cinq minutes. |
| Critère d'abandon | §19 — **à remplir avant la première ligne de code.** |

## 21. Décisions ouvertes

1. **Nom du projet.**
2. **Où vit la mémoire quand il n'y a pas de feature ?** Un workspace C0 a-t-il droit à une mémoire persistante, ou seulement à un journal ?
3. **Le manifest est-il unique par projet, ou peut-il être composé** (un fichier racine + des fichiers par repo) ?
4. **Stratégie d'arborescence par défaut** pour un nouveau projet multi-repo : groupée par feature, ou plate par repo ?
5. **Politique de rétention** des sessions et journaux.
