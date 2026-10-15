# Horizon, site de test

Ce dépôt publie https://antonin-winterstein.github.io/ avec GitHub Pages. Le site imite un
réseau fictif de centres de loisirs, Horizon, et sert à deux tests : l'exploration du site par
un robot (crawler) et les notifications web sur un site à plusieurs dossiers.

## Test du crawler

Le crawler part de l'accueil et suit les liens. Chaque page vérifie un cas précis.

| Page | Ce qu'elle vérifie |
| --- | --- |
| `index.html` | Le point de départ du crawl. |
| `tarifs.html`, `faq.html`, `contact.html`, `produits/` | Des pages à un clic de l'accueil : le crawler doit les lire. |
| `produits/produit-a.html`, `produits/produit-b.html` | Des pages à deux clics : le crawler doit les lire aussi. |
| `orpheline.html` | La page figure dans `sitemap.xml`, mais aucun lien n'y mène. Le crawler ne doit pas la trouver (marqueur `MARQUEUR-ORPHELINE-67890`). |
| `admin/secret.html` | `robots.txt` interdit `/admin/`. Le crawler ne doit pas la lire (marqueur `MARQUEUR-SECRET-12345`). |
| Lien « Un site externe » | Le crawler ne doit pas sortir du domaine. |

Les pages Paris, Rome et Berlin sont liées depuis l'accueil, donc le crawler les voit. Elles
portent une balise `noindex` et ne figurent pas dans `sitemap.xml`.

## Test des notifications web sur plusieurs dossiers

Le test reproduit un site à plusieurs dossiers sur un même domaine, comme un WordPress
multisite en sous-dossiers : un seul domaine, et un centre par dossier.

```
/                 accueil, sans notifications (comme l'accueil d'un réseau)
/paris/           page + AIBSDKWorker.js, portée /paris/
/rome/            page + AIBSDKWorker.js, portée /rome/
/berlin/          page + AIBSDKWorker.js, portée /berlin/
```

Chaque page de centre charge le SDK avec `data-sw-path` et `data-sw-scope` sur son dossier. Le
navigateur enregistre donc un worker par centre, et chaque worker reçoit sa propre adresse
d'abonnement. Le navigateur donne en revanche une seule autorisation de notification pour tout
le domaine.

Le panneau « Notifications sur ce domaine » (`assets/push-panel.js`) affiche cet état sur
chaque page de centre : l'autorisation du domaine, puis un voyant par centre.

- Gris : le navigateur n'a pas de worker pour ce centre.
- Orange : le worker existe, mais le navigateur n'a pas d'abonnement.
- Vert : le navigateur est abonné, et le panneau montre la fin de l'adresse d'abonnement.

### Branchement sur une instance de test

Pendant le test, les notifications passent par une instance de test, joignable par un tunnel :

- `assets/aib-local.js` redirige vers le tunnel les appels de notifications faits par la page.
  Le chatbot n'est pas concerné.
- Chaque `AIBSDKWorker.js` de centre fait la même redirection, puis ignore les statistiques
  d'affichage et de clic.

Les pages et les workers des centres chargent une version modifiée du SDK, rangée dans
`assets/sdk/`. Cette version garde un état par centre et demande l'accord du visiteur pour
chaque centre.

Si l'adresse du tunnel change, la commande suivante liste les fichiers à mettre à jour :

```bash
grep -rl pinggy.link --exclude-dir=.git .
```

Pendant que le tunnel est ouvert, l'instance de test est joignable depuis internet. Le tunnel
ne doit tourner que pendant un test.

### Revenir à l'intégration d'origine

L'accueil garde l'intégration d'origine des notifications en commentaire. Pour la rétablir, il
suffit de retirer le commentaire. Le fichier `AIBSDKWorker.js` à la racine reste le worker de
cette intégration.

## Icônes

- `favicon.svg`, `favicon.ico` et `apple-touch-icon.png` : la favicon d'Horizon.
- `icons/horizon-192.png` et `icons/horizon-512.png` : les icônes de l'application, citées
  par `manifest.json`. Le manifeste permet aussi les notifications sur iPhone, après l'ajout
  du site à l'écran d'accueil.
- `icon-192x192.png` : l'ancienne icône. L'intégration d'origine l'utilise peut-être comme
  icône de notification, donc le fichier reste en place.

## Photos

Les photos des centres viennent de Wikimedia Commons :

- Paris : [Zinneke](https://commons.wikimedia.org/wiki/File:Seine_and_Eiffel_Tower_from_Tour_Saint_Jacques_2013-08.JPG), CC BY-SA 3.0 ;
- Rome : [Diliff](https://commons.wikimedia.org/wiki/File:Colosseum_in_Rome,_Italy_-_April_2007.jpg), CC BY-SA 2.5 ;
- Berlin : [Thomas Wolf](https://commons.wikimedia.org/wiki/File:Brandenburger_Tor_abends.jpg), CC BY-SA 3.0.
