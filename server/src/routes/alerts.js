import { Router } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

/** Médicaments dont la date d'expiration est dans les `days` prochains jours */
router.get("/", async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const now = new Date();
  const limit = new Date(now);
  limit.setDate(limit.getDate() + days);

  const lots = await prisma.lot.findMany({
    where: {
      quantite: { gt: 0 },
      dateExpiration: {
        lte: limit,
      },
    },
    orderBy: { dateExpiration: "asc" },
    include: {
      medicament: {
        select: {
          id: true,
          nom: true,
          principeActif: true,
          dosage: true,
        },
      },
    },
  });

  res.json({
    days,
    count: lots.length,
    items: lots.map((lot) => {
      const diffMs = new Date(lot.dateExpiration).getTime() - now.getTime();
      const daysRemaining = Math.floor(diffMs / (24 * 60 * 60 * 1000));
      const urgency =
        daysRemaining < 0
          ? "expired"
          : daysRemaining < 7
            ? "critical"
            : daysRemaining < 30
              ? "warning"
              : "attention";

      return {
        id: lot.id,
        medicamentId: lot.medicament.id,
        nom: lot.medicament.nom,
        principeActif: lot.medicament.principeActif,
        dosage: lot.medicament.dosage,
        quantite: lot.quantite,
        numeroLot: lot.numeroLot,
        dateExpiration: lot.dateExpiration,
        daysRemaining,
        urgency,
      };
    }),
  });
});

export default router;
