const express = require('express');
const bcrypt = require('bcrypt');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { signToken } = require('../lib/jwt');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Ne renvoie jamais le hash du mot de passe dans les réponses de l'API
function toPublicUser(user) {
  const { passwordHash, ...publicUser } = user;
  return publicUser;
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string()
    .min(8, 'Le mot de passe doit contenir au moins 8 caractères.')
    .regex(/\d/, 'Le mot de passe doit contenir au moins un chiffre.')
    .regex(/[!@#$%^&*(),.?":{}|<>_\-+=[\]/\\~`;']/, 'Le mot de passe doit contenir au moins un caractère spécial.'),
  nom: z.string().min(1),
  age: z.number().int().positive().optional(),
  telephone: z.string().optional(),
});

router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { email, password, nom, age, telephone } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: { email, passwordHash, nom, age, telephone },
  });

  const token = signToken(user);
  res.status(201).json({ user: toPublicUser(user), token });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  const token = signToken(user);
  res.json({ user: toPublicUser(user), token });
});

// Route protégée : renvoie le profil de l'utilisateur actuellement connecté
router.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    include: { vehicule: true },
  });

  if (!user) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  res.json({ user: toPublicUser(user) });
});

module.exports = router;
