const express = require('express');
const stripe = require('../lib/stripe');
const prisma = require('../lib/prisma');

const router = express.Router();

// IMPORTANT : cette route a besoin du corps brut (non parsé en JSON) pour
// vérifier la signature Stripe. Elle est montée AVANT express.json() dans
// server.js avec express.raw() — ne jamais déplacer app.use(express.json())
// avant cette route.
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature Stripe invalide :', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    await prisma.paiement.updateMany({
      where: { stripePaymentId: paymentIntent.id },
      data: { statut: 'PAID' },
    });
  }

  if (event.type === 'payment_intent.payment_failed') {
    const paymentIntent = event.data.object;
    await prisma.paiement.updateMany({
      where: { stripePaymentId: paymentIntent.id },
      data: { statut: 'FAILED' },
    });
  }

  res.json({ received: true });
});

module.exports = router;
