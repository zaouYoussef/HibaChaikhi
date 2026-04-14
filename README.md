# Caravane médicale — application web

Application complète pour préparer une caravane médicale : enregistrement des médicaments (scan code-barres ou saisie), gestion des lots, recherche orientée pharmacien avec priorité à l’expiration la plus proche, équivalents par principe actif, tableau de bord, alertes et historique de délivrance.

## Stack

- **Frontend** : React (Vite), Tailwind CSS, `html5-qrcode`, PWA (`vite-plugin-pwa`)
- **Backend** : Node.js, Express
- **Base** : PostgreSQL + Prisma
- **Auth** : JWT (inscription + connexion)

## Prérequis

- Node.js 18+
- PostgreSQL accessible (locale ou Docker)

## Installation

### 1. Base de données

Créez une base PostgreSQL, par exemple :

```sql
CREATE DATABASE caravane_medicale;
```

### 2. Backend (`server/`)

```bash
cd server
copy .env.example .env
```

Éditez `.env` : renseignez `DATABASE_URL` et un `JWT_SECRET` fort.

```bash
npm install
npx prisma generate
npx prisma db push
npm run db:migrate-lots
npm run db:seed
npm run dev
```

L’API écoute par défaut sur **http://localhost:4000** (`GET /health` pour vérifier).

### 3. Frontend (`client/`)

```bash
cd client
npm install
npm run dev
```

L’interface est sur **http://localhost:5173**. Le proxy Vite redirige `/auth`, `/scan`, `/search`, `/medicaments`, `/alerts`, `/equivalents`, `/dashboard`, `/history` vers le port 4000.

**Production** : définissez `VITE_API_URL` (URL publique de l’API, sans slash final) avant `npm run build`.

## API (routes protégées sauf auth et health)

| Méthode | Route | Description |
|--------|--------|-------------|
| POST | `/auth/register` | Inscription |
| POST | `/auth/login` | Connexion → `{ token, user }` |
| GET | `/health` | Santé du service |
| POST | `/medicaments` | Ajouter un médicament |
| GET | `/medicaments` | Liste |
| POST | `/scan` | Scanner un code-barres/QR : lookup local puis OpenFDA |
| GET | `/search?q=` | Recherche intelligente (LIKE + fuzzy, priorité expiration) |
| GET | `/suggest?q=` | Suggestions locales + RxNorm (autocomplete enrichi) |
| GET | `/autocomplete?q=` | Alias simple autocomplete (liste de noms) |
| GET | `/medicaments/search?q=` | Alias de compatibilité pour la recherche |
| PUT | `/medicaments/:id/use` | Décrémenter le stock (`body`: `{ "quantite": 1 }`) |
| GET | `/alerts?days=30` | Alertes d’expiration |
| GET | `/history?limit=100` | Historique des délivrances |
| GET | `/dashboard/stats` | Totaux / expirations / stock faible |
| GET / POST / DELETE | `/equivalents` | Liste, ajout, suppression d’entrées d’équivalence |

Toutes les routes sauf `/auth/*` et `/health` nécessitent l’en-tête : `Authorization: Bearer <token>`.

## PWA (mode hors ligne partiel)

Après `npm run build` et déploiement en HTTPS, le navigateur peut installer l’application. Les assets statiques sont mis en cache ; les appels API restent soumis au réseau (comportement normal pour des données à jour).

## Structure du dépôt

```
hiba/
  server/          # API Express + Prisma
  client/          # SPA React
  README.md
```

## Déploiement Vercel + Railway

### 1) Pousser le code sur GitHub

```bash
cd /chemin/vers/hiba
git init
git add .
git commit -m "prepare production deploy"
git branch -M main
git remote add origin https://github.com/zaouYoussef/HibaChaikhi.git
git push -u origin main
```

### 2) Déployer le backend sur Railway

- Créez un nouveau projet Railway depuis ce repo.
- Définissez le **Root Directory** du service backend sur `server`.
- Ajoutez un service **PostgreSQL** dans Railway.
- Variables d’environnement backend:
  - `DATABASE_URL` = variable PostgreSQL Railway
  - `JWT_SECRET` = secret fort
  - `CORS_ORIGIN` = URL Vercel frontend (ex: `https://hiba-chaikhi.vercel.app`)
- Railway lancera `npm run start:railway` (inclut `prisma db push` au démarrage).
- Récupérez l’URL publique backend Railway (ex: `https://xxx.up.railway.app`).

### 3) Déployer le frontend sur Vercel

- Créez un projet Vercel depuis le même repo.
- Définissez le **Root Directory** sur `client`.
- Variable d’environnement frontend:
  - `VITE_API_URL` = URL Railway backend
- Le fichier `client/vercel.json` gère le fallback SPA.

### 4) Vérification rapide

- Ouvrir frontend Vercel.
- Tester `connexion`, `recherche`, `donner`, `historique`.
- Vérifier `GET /health` sur l’URL Railway.
