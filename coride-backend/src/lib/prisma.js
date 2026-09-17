const { PrismaClient } = require('@prisma/client');

// Une seule instance de PrismaClient est réutilisée partout dans l'app
// (évite d'ouvrir trop de connexions à la base de données).
const prisma = new PrismaClient();

module.exports = prisma;
