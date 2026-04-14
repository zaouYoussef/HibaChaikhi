import { Router } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

router.get("/", async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));

  const rows = await prisma.dispenseHistory.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      medicament: {
        select: {
          id: true,
          nom: true,
          principeActif: true,
          dosage: true,
        },
      },
      lot: {
        select: {
          id: true,
          numeroLot: true,
          dateExpiration: true,
        },
      },
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });

  res.json({
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      quantite: r.quantite,
      date: r.createdAt,
      medicament: r.medicament,
      lot: r.lot,
      utilisateur: {
        id: r.user.id,
        nom: r.user.name || r.user.email,
      },
    })),
  });
});

export default router;
