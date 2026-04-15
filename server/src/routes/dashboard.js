import { Router } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

router.get("/stats", async (_req, res) => {
  const now = new Date();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  endOfMonth.setHours(23, 59, 59, 999);
  const [total, lotsSoon, meds] = await Promise.all([
    prisma.medicament.count(),
    prisma.lot.count({
      where: {
        quantite: { gt: 0 },
        dateExpiration: { lte: endOfMonth },
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
    fenetreExpiration: "fin_du_mois",
  });
});

export default router;
