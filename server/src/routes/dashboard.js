import { Router } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

router.get("/stats", async (_req, res) => {
  const now = new Date();
  const in30 = new Date(now);
  in30.setDate(in30.getDate() + 30);
  const [total, lotsSoon, meds] = await Promise.all([
    prisma.medicament.count(),
    prisma.lot.count({
      where: {
        quantite: { gt: 0 },
        dateExpiration: { lte: in30 },
      },
    }),
    prisma.medicament.findMany({
      include: {
        lots: {
          where: { quantite: { gt: 0 } },
        },
      },
    }),
  ]);

  const stockFaible = meds.filter((m) => {
    const stock = (m.lots ?? []).reduce((sum, lot) => sum + lot.quantite, 0);
    return stock > 0 && stock <= 10;
  }).length;

  res.json({
    totalMedicaments: total,
    bientotExpires: lotsSoon,
    stockFaible,
    seuilStockFaible: 10,
    fenetreExpirationJours: 30,
  });
});

export default router;
