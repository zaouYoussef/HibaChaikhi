import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

const router = Router();

const equivSchema = z.object({
  principeActif: z.string().min(1).max(300),
  nomMedicament: z.string().min(1).max(300),
});

router.get("/", async (_req, res) => {
  const list = await prisma.equivalent.findMany({
    orderBy: { principeActif: "asc" },
  });
  res.json(list);
});

router.post("/", async (req, res) => {
  const parsed = equivSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const row = await prisma.equivalent.create({ data: parsed.data });
  res.status(201).json(row);
});

router.delete("/:id", async (req, res) => {
  try {
    await prisma.equivalent.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Équivalent introuvable" });
  }
});

export default router;
