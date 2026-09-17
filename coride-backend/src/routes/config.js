const express = require('express');
const router = express.Router();

// La clé publique Stripe (pk_test_...) n'est pas un secret : elle est faite
// pour être utilisée côté navigateur. La clé secrète (sk_test_...), elle,
// ne quitte jamais le serveur.
router.get('/', (req, res) => {
  res.json({ stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

module.exports = router;
