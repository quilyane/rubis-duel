# Rubis Duel

Jeu d'enchères à deux, en ligne. Chaque joueur a **500 rubis** et doit remplir une équipe de **5 personnages** en enchérissant à tour de rôle. À la fin, les joueurs votent pour dire qui a gagné.

- Salon privé avec **lien d'invitation**
- **Système d'amis** (code ami, demandes, invitations, « Rejoindre » le salon d'un ami)
- 10 decks fournis : One Piece, Naruto, Dragon Ball Z, Demon Slayer, Jujutsu Kaisen, Bleach, Blue Lock, Kuroko no Basket, My Hero Academia, Kingdom
- **Mode Bluff** : seul le joueur qui ouvre voit le personnage, avec un classement **Ki** (voir plus bas)
- Aucune dépendance : Node 18+ suffit (pas de `npm install`)

## Lancer en local

```bash
node server.js          # puis ouvre http://localhost:3000
npm test                # simule une partie complète à deux joueurs
```

Pour tester seul, ouvre deux onglets, dont un en navigation privée (sinon les deux onglets partagent le même joueur).

## Mettre en ligne gratuitement (Render)

1. Crée un dépôt GitHub et envoie-y ce dossier.
2. Sur https://render.com : **New → Web Service**, choisis ton dépôt. Render lit `render.yaml` tout seul (Node, plan Free).
3. Une fois déployé, tu obtiens une URL du type `https://rubis-duel.onrender.com`. Partage-la, c'est tout.

Notes sur l'offre gratuite :
- Le serveur s'endort après ~15 min sans visite et met ~30 s à se réveiller.
- Le disque est effacé à chaque redéploiement : les **comptes et listes d'amis** sont perdus à ce moment-là. Pour les conserver, ajoute un disque persistant (offre payante) et définis la variable `DATA_DIR` sur son chemin.
- Les parties en cours vivent en mémoire : un redémarrage du serveur les interrompt.

D'autres hébergeurs Node (Railway, Fly.io, un VPS) fonctionnent de la même façon : `node server.js`, variable `PORT` respectée. Il faut que l'hébergeur autorise les WebSockets (c'est le cas partout ci-dessus).

## Ajouter les images des personnages

Les cartes affichent les initiales tant qu'il n'y a pas d'image. Pour ajouter les portraits :

```bash
npm run images
```

Cette commande crée un dossier par deck dans `public/img/` et liste le nom exact de chaque fichier attendu, par exemple :

```
public/img/one-piece/monkey-d-luffy.webp
public/img/naruto/naruto-uzumaki.png
```

Formats acceptés : webp, png, jpg, avif, gif. Format portrait 3:4 conseillé (ex. 600×800). Les images sont détectées au démarrage de chaque partie, pas besoin de redémarrer.

## Ajouter ou modifier un deck

Crée un fichier `decks/mon-deck.json` :

```json
{
  "id": "mon-deck",
  "name": "Mon deck",
  "tagline": "Une phrase de présentation",
  "color": "#e8503a",
  "characters": [
    { "id": "nom-du-perso", "name": "Nom du perso", "tier": "S" }
  ]
}
```

`tier` : `S` Légendaire, `A` Épique, `B` Rare, `C` Commun (simple indication visuelle, les rubis se règlent aux enchères). Il faut au moins 12 personnages. Redémarre le serveur pour qu'il apparaisse.

## Règles (modifiables dans `server.js`, objet `RULES`)

| Règle | Valeur |
|---|---|
| Budget de départ | 500 rubis |
| Équipe | 5 personnages |
| Mise d'ouverture / pas minimum | 10 rubis |
| Temps par réponse | 30 s (sans réponse : ouverture à 10, ou passe) |
| Qui ouvre | Alterne à chaque personnage, premier joueur tiré au sort |

Précisions que j'ai dû trancher :
- Il faut garder **10 rubis par place encore vide**, pour ne jamais bloquer un joueur dans l'incapacité de finir son équipe.
- Si une équipe est complète avant l'autre, les personnages restants vont à l'autre joueur au prix d'ouverture (10 rubis).
- Si l'adversaire ne peut plus surenchérir, le personnage est adjugé tout de suite.
- Si un joueur se déconnecte pendant les enchères et ne revient pas en 10 secondes, la partie est annulée et l'autre joueur retrouve le salon.
- Le résultat final est déclaré quand les deux joueurs votent la même chose ; sinon ils peuvent discuter (chat intégré) et revoter.

## Mode Bluff et classement Ki

À la création du salon (modifiable ensuite par l'hôte), on choisit **Classique** (carte visible par les deux) ou **Bluff** : seul le joueur qui ouvre voit le personnage en vente. L'autre joue à l'aveugle, d'après les mises. La carte est révélée à l'adjugé. Elle n'est jamais envoyée au navigateur de l'autre joueur (vérifié par le test automatique), donc impossible de la lire avec les outils du navigateur.

Le **Ki** ne bouge que dans ce mode : départ à 200, +20 par victoire, -20 par défaite (jamais sous 0). Il est mis à jour quand les deux joueurs votent pareil pour un vainqueur, puis les votes se verrouillent. Une égalité ne change rien. Une partie annulée ou quittée avant le vote ne change rien non plus. Réglages dans `server.js` (objet `KI`). Le Ki est stocké avec le compte, il suit donc la même règle de sauvegarde que les amis (voir la section déploiement).

## Structure

```
server.js        serveur HTTP + règles du jeu + salons + amis
miniws.js        WebSocket minimal (aucune dépendance)
decks/*.json     les decks
public/          le site (index.html, style.css, app.js, img/)
tools/           selftest.js (test de bout en bout), images.js
```
