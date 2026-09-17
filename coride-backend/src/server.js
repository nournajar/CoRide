require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const prisma = require('./lib/prisma');
const { verifyToken } = require('./lib/jwt');
const { canAccessTrajetChat } = require('./routes/messages');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());

// Le webhook Stripe doit être monté AVANT express.json() : il a besoin du
// corps de requête brut pour vérifier la signature envoyée par Stripe.
app.use('/api/webhooks', require('./routes/webhooks'));

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'coride-backend' });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/trajets', require('./routes/trajets'));
app.use('/api/reservations', require('./routes/reservations'));
app.use('/api/config', require('./routes/config'));
app.use('/api/messages', require('./routes/messages'));

// ---------- Messagerie temps réel ----------
// Le client se connecte avec : io(URL, { auth: { token: "<JWT>" } })
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentification requise.'));
    const payload = verifyToken(token);
    socket.userId = payload.userId;
    next();
  } catch (err) {
    next(new Error('Jeton invalide ou expiré.'));
  }
});

io.on('connection', (socket) => {
  console.log('Client connecté au chat:', socket.id, 'user:', socket.userId);

  // Chaque utilisateur rejoint automatiquement sa propre "room" personnelle —
  // c'est ce qui permet de lui envoyer une notification même s'il n'a pas la
  // conversation ouverte à ce moment-là.
  socket.join('user:' + socket.userId);

  // Le client doit rejoindre la "room" du trajet avant d'échanger des messages
  socket.on('join_trajet', async ({ trajetId }) => {
    const allowed = await canAccessTrajetChat(socket.userId, trajetId);
    if (!allowed) {
      socket.emit('error_message', "Vous n'avez pas accès à cette conversation.");
      return;
    }
    socket.join('trajet:' + trajetId);
  });

  socket.on('send_message', async ({ trajetId, contenu }) => {
    if (!contenu || !contenu.trim()) return;

    const allowed = await canAccessTrajetChat(socket.userId, trajetId);
    if (!allowed) {
      socket.emit('error_message', "Vous n'avez pas accès à cette conversation.");
      return;
    }

    const message = await prisma.message.create({
      data: { trajetId, expediteurId: socket.userId, contenu: contenu.trim() },
      include: { expediteur: { select: { id: true, nom: true, photoUrl: true } } },
    });

    io.to('trajet:' + trajetId).emit('new_message', message);

    // Notification ciblée : on prévient le conducteur et les passagers de ce
    // trajet (sauf l'expéditeur lui-même) pour qu'ils voient une alerte même
    // s'ils n'ont pas cette conversation ouverte.
    const trajet = await prisma.trajet.findUnique({
      where: { id: trajetId },
      include: { reservations: { select: { passagerId: true } } },
    });

    if (trajet) {
      const recipientIds = new Set([trajet.conducteurId, ...trajet.reservations.map(r => r.passagerId)]);
      recipientIds.delete(socket.userId);

      recipientIds.forEach((uid) => {
        io.to('user:' + uid).emit('message_notification', {
          trajetId,
          villeDepart: trajet.villeDepart,
          villeArrivee: trajet.villeArrivee,
          expediteurNom: message.expediteur.nom,
          contenu: message.contenu,
          createdAt: message.createdAt,
        });
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client déconnecté:', socket.id);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`CoRide backend démarré sur le port ${PORT}`);
});
