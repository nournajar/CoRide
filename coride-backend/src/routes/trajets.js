const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Distance en kilomètres entre deux points GPS (formule de Haversine)
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- Publier un trajet ----------

const trajetSchema = z.object({
  villeDepart: z.string().min(1),
  villeArrivee: z.string().min(1),
  latDepart: z.number(),
  lngDepart: z.number(),
  latArrivee: z.number(),
  lngArrivee: z.number(),
  dateHeure: z.string().datetime().or(z.string().min(1)), // ISO string envoyé par le client
  prixParPlace: z.number().positive(),
  placesDispo: z.number().int().positive(),
});

router.post('/', requireAuth, async (req, res) => {
  const parsed = trajetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  // Un conducteur doit avoir renseigné son véhicule avant de pouvoir publier un trajet
  const vehicule = await prisma.vehicule.findUnique({ where: { conducteurId: req.userId } });
  if (!vehicule) {
    return res.status(400).json({ error: 'Ajoutez votre véhicule avant de publier un trajet.' });
  }

  const { placesDispo } = parsed.data;
  if (placesDispo > vehicule.placesTotal) {
    return res.status(400).json({ error: 'Le nombre de places dépasse la capacité du véhicule.' });
  }

  const trajet = await prisma.trajet.create({
    data: {
      ...parsed.data,
      dateHeure: new Date(parsed.data.dateHeure),
      conducteurId: req.userId,
    },
  });

  res.status(201).json({ trajet });
});

// ---------- Rechercher des trajets ----------
// Filtres possibles (tous optionnels, combinables) :
//   ?villeDepart=Tunis&villeArrivee=Sousse&date=2026-08-20
//   ?lat=36.8065&lng=10.1815&radius=50   → trajets dont le départ est à moins de "radius" km

router.get('/', async (req, res) => {
  const { villeDepart, villeArrivee, date, lat, lng, radius } = req.query;

  const where = {
    dateHeure: { gte: new Date() }, // uniquement les trajets à venir
    // (les trajets marqués "complet" par le conducteur restent visibles,
    // ils sont juste affichés comme complets côté frontend)
  };

  if (villeDepart) where.villeDepart = { contains: String(villeDepart), mode: 'insensitive' };
  if (villeArrivee) where.villeArrivee = { contains: String(villeArrivee), mode: 'insensitive' };

  if (date) {
    const start = new Date(String(date));
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    where.dateHeure = { gte: start, lt: end };
  }

  let trajets = await prisma.trajet.findMany({
    where,
    orderBy: { dateHeure: 'asc' },
    include: {
      conducteur: {
        select: { id: true, nom: true, photoUrl: true },
      },
    },
  });

  // Filtre + tri par proximité géographique si lat/lng fournis
  if (lat && lng) {
    const userLat = parseFloat(String(lat));
    const userLng = parseFloat(String(lng));
    const maxRadius = radius ? parseFloat(String(radius)) : 50;

    trajets = trajets
      .map((t) => ({
        ...t,
        distanceKm: distanceKm(userLat, userLng, t.latDepart, t.lngDepart),
      }))
      .filter((t) => t.distanceKm <= maxRadius)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  res.json({ trajets });
});

// ---------- Détail d'un trajet ----------

router.get('/:id', async (req, res) => {
  const trajet = await prisma.trajet.findUnique({
    where: { id: req.params.id },
    include: {
      conducteur: {
        select: { id: true, nom: true, photoUrl: true, nonFumeur: true, musique: true, climatisation: true, animauxAcceptes: true },
      },
    },
  });

  if (!trajet) {
    return res.status(404).json({ error: 'Trajet introuvable.' });
  }

  res.json({ trajet });
});

// ---------- Mes trajets publiés (conducteur) ----------

router.get('/mine/publies', requireAuth, async (req, res) => {
  const trajets = await prisma.trajet.findMany({
    where: { conducteurId: req.userId },
    orderBy: { dateHeure: 'desc' },
  });
  res.json({ trajets });
});

// ---------- Marquer un trajet complet / disponible (conducteur uniquement) ----------

router.patch('/:id/complet', requireAuth, async (req, res) => {
  const { complet } = req.body;
  if (typeof complet !== 'boolean') {
    return res.status(400).json({ error: 'Le champ complet doit être vrai ou faux.' });
  }

  const trajet = await prisma.trajet.findUnique({ where: { id: req.params.id } });
  if (!trajet) {
    return res.status(404).json({ error: 'Trajet introuvable.' });
  }
  if (trajet.conducteurId !== req.userId) {
    return res.status(403).json({ error: 'Vous ne pouvez modifier que vos propres trajets.' });
  }

  const updated = await prisma.trajet.update({
    where: { id: req.params.id },
    data: { complet },
  });

  res.json({ trajet: updated });
});

module.exports = router;
