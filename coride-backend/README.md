# CoRide — Backend

## Installation

```bash
npm install
cp .env.example .env
# renseigner DATABASE_URL, JWT_SECRET, STRIPE_SECRET_KEY, CLOUDINARY_* dans .env
```

## Base de données

Il faut une base PostgreSQL avec l'extension PostGIS activée :

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

Puis générer les tables à partir du schéma Prisma :

```bash
npm run prisma:migrate
npm run prisma:generate
```

## Lancer le serveur

```bash
npm run dev
```

Le serveur démarre sur `http://localhost:4000`. Vérification : `GET /api/health`.

## Structure

```
prisma/schema.prisma   → schéma de la base de données
src/server.js          → point d'entrée Express + Socket.io
src/routes/            → routes de l'API (à venir)
```

## Modèles de données

- **User** — profil, préférences, statut de vérification identité/permis
- **Vehicule** — un véhicule par conducteur
- **Trajet** — trajets publiés, avec coordonnées pour la recherche géographique
- **Reservation** — réservations d'un passager sur un trajet
- **Paiement** — lié à Stripe pour les paiements carte, jamais de données bancaires stockées
- **Message** — messagerie liée à un trajet
