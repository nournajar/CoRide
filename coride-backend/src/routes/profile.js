const express = require('express');
const multer = require('multer');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { uploadBuffer } = require('../lib/cloudinary');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Les fichiers sont gardés en mémoire le temps de les envoyer à Cloudinary,
// jamais écrits sur le disque du serveur ni stockés en base.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo max
});

function toPublicUser(user) {
  const { passwordHash, ...publicUser } = user;
  return publicUser;
}

// ---------- Infos personnelles + préférences ----------

const profileSchema = z.object({
  nom: z.string().min(1).optional(),
  age: z.number().int().positive().optional(),
  telephone: z.string().optional(),
  nonFumeur: z.boolean().optional(),
  musique: z.boolean().optional(),
  climatisation: z.boolean().optional(),
  animauxAcceptes: z.boolean().optional(),
});

router.patch('/', requireAuth, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const user = await prisma.user.update({
    where: { id: req.userId },
    data: parsed.data,
  });

  res.json({ user: toPublicUser(user) });
});

// ---------- Véhicule ----------

const vehiculeSchema = z.object({
  marque: z.string().min(1),
  modele: z.string().min(1),
  couleur: z.string().min(1),
  immatriculation: z.string().min(1),
  placesTotal: z.number().int().positive(),
});

router.put('/vehicule', requireAuth, async (req, res) => {
  const parsed = vehiculeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  // Un seul véhicule par conducteur : on le crée s'il n'existe pas, sinon on le met à jour.
  const vehicule = await prisma.vehicule.upsert({
    where: { conducteurId: req.userId },
    update: parsed.data,
    create: { ...parsed.data, conducteurId: req.userId },
  });

  // L'immatriculation n'est jamais renvoyée telle quelle dans une réponse publique de l'API.
  const { immatriculation, ...publicVehicule } = vehicule;
  res.json({ vehicule: publicVehicule });
});

// ---------- Upload : photo de profil ----------

router.post('/photo', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier reçu.' });
  }

  try {
    const result = await uploadBuffer(req.file.buffer, 'photos-profil');
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { photoUrl: result.secure_url },
    });
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    res.status(502).json({ error: "Échec de l'envoi de la photo. Réessayez." });
  }
});

// ---------- Upload : vérification d'identité ----------

router.post('/verification/identite', requireAuth, upload.single('document'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier reçu.' });
  }

  try {
    const result = await uploadBuffer(req.file.buffer, 'verification-identite');
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { identiteUrl: result.secure_url, identiteStatus: 'PENDING' },
    });
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    res.status(502).json({ error: "Échec de l'envoi du document. Réessayez." });
  }
});

// ---------- Upload : vérification du permis ----------

router.post('/verification/permis', requireAuth, upload.single('document'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier reçu.' });
  }

  try {
    const result = await uploadBuffer(req.file.buffer, 'verification-permis');
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { permisUrl: result.secure_url, permisStatus: 'PENDING' },
    });
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    res.status(502).json({ error: "Échec de l'envoi du document. Réessayez." });
  }
});

module.exports = router;
