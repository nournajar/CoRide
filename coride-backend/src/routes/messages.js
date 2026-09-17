const express = require('express');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Vérifie que l'utilisateur a le droit de voir/écrire dans la conversation
// d'un trajet : il suffit d'être connecté et que le trajet existe — un
// passager peut ainsi poser une question au conducteur avant de réserver.
async function canAccessTrajetChat(userId, trajetId) {
  const trajet = await prisma.trajet.findUnique({ where: { id: trajetId } });
  return !!trajet;
}

router.get('/:trajetId', requireAuth, async (req, res) => {
  const { trajetId } = req.params;

  const allowed = await canAccessTrajetChat(req.userId, trajetId);
  if (!allowed) {
    return res.status(403).json({ error: "Vous n'avez pas accès à cette conversation." });
  }

  const messages = await prisma.message.findMany({
    where: { trajetId },
    orderBy: { createdAt: 'asc' },
    include: { expediteur: { select: { id: true, nom: true, photoUrl: true } } },
  });

  res.json({ messages });
});

module.exports = router;
module.exports.canAccessTrajetChat = canAccessTrajetChat;
