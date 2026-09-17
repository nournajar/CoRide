const { verifyToken } = require('../lib/jwt');

// À utiliser sur toute route qui doit être réservée aux utilisateurs connectés,
// par exemple : router.post('/trajets', requireAuth, ...)
function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }

  const token = header.split(' ')[1];

  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Jeton invalide ou expiré.' });
  }
}

module.exports = { requireAuth };
