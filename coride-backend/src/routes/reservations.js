const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const stripe = require('../lib/stripe');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ---------- Créer une réservation ----------

const reservationSchema = z.object({
  trajetId: z.string().min(1),
  placesReservees: z.number().int().positive(),
  methodePaiement: z.enum(['ESPECES', 'CARTE']),
});

router.post('/', requireAuth, async (req, res) => {
  const parsed = reservationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { trajetId, placesReservees, methodePaiement } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const trajet = await tx.trajet.findUnique({ where: { id: trajetId } });

      if (!trajet) {
        throw { status: 404, message: 'Trajet introuvable.' };
      }
      if (trajet.conducteurId === req.userId) {
        throw { status: 400, message: 'Vous ne pouvez pas réserver votre propre trajet.' };
      }
      if (trajet.placesDispo < placesReservees) {
        throw { status: 400, message: 'Pas assez de places disponibles sur ce trajet.' };
      }

      const montantTotal = Number(trajet.prixParPlace) * placesReservees;

      await tx.trajet.update({
        where: { id: trajetId },
        data: { placesDispo: trajet.placesDispo - placesReservees },
      });

      const reservation = await tx.reservation.create({
        data: {
          trajetId,
          passagerId: req.userId,
          placesReservees,
          montantTotal,
          statut: 'CONFIRMED',
        },
      });

      // Le paiement carte réel (Stripe PaymentIntent + 3D Secure) sera branché
      // à cette étape ; pour l'instant le paiement est enregistré en attente.
      const paiement = await tx.paiement.create({
        data: {
          reservationId: reservation.id,
          methode: methodePaiement,
          montant: montantTotal,
          statut: 'PENDING',
        },
      });

      return { reservation, paiement };
    });

    // Paiement carte : on crée un PaymentIntent Stripe pour que le frontend
    // puisse le confirmer (3D Secure, saisie carte...). Le paiement reste
    // "PENDING" en base tant que le webhook Stripe ne confirme pas le succès.
    // Note : test uniquement pour l'instant (Stripe ne supporte pas encore
    // les comptes marchands basés en Tunisie ni le dinar tunisien).
    let clientSecret = null;
    if (methodePaiement === 'CARTE') {
      const amountInCents = Math.round(result.paiement.montant * 100);
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency: 'usd',
        metadata: { reservationId: result.reservation.id },
      });

      await prisma.paiement.update({
        where: { id: result.paiement.id },
        data: { stripePaymentId: paymentIntent.id },
      });

      clientSecret = paymentIntent.client_secret;
    }

    res.status(201).json({ ...result, clientSecret });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la réservation.' });
  }
});

// ---------- Historique des réservations et paiements de l'utilisateur connecté ----------

router.get('/me', requireAuth, async (req, res) => {
  const reservations = await prisma.reservation.findMany({
    where: { passagerId: req.userId },
    orderBy: { createdAt: 'desc' },
    include: {
      trajet: {
        select: {
          villeDepart: true,
          villeArrivee: true,
          dateHeure: true,
          conducteur: { select: { nom: true } },
        },
      },
      paiement: true,
    },
  });

  res.json({ reservations });
});

// ---------- Annuler une réservation ----------

router.patch('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: req.params.id },
        include: { trajet: true },
      });

      if (!reservation) {
        throw { status: 404, message: 'Réservation introuvable.' };
      }
      if (reservation.passagerId !== req.userId) {
        throw { status: 403, message: "Vous ne pouvez annuler que vos propres réservations." };
      }
      if (reservation.statut === 'CANCELLED') {
        throw { status: 400, message: 'Cette réservation est déjà annulée.' };
      }

      await tx.trajet.update({
        where: { id: reservation.trajetId },
        data: { placesDispo: reservation.trajet.placesDispo + reservation.placesReservees },
      });

      const updated = await tx.reservation.update({
        where: { id: reservation.id },
        data: { statut: 'CANCELLED' },
      });

      return updated;
    });

    res.json({ reservation: result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Erreur lors de l'annulation." });
  }
});

module.exports = router;
