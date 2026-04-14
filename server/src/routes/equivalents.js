import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

const router = Router();

const equivSchema = z.object({
  principeActif: z.string().min(1).max(300),
  nomMedicament: z.string().min(1).max(300),
});

function isValidEquivalentName(value) {
  const name = String(value ?? "").trim();
  if (!name) return false;
  if (name.includes("{") || name.includes("}")) return false;
  if (/\bpack\b/i.test(name)) return false;
  if (name.split("/").length > 2) return false;
  return true;
}

router.get("/", async (_req, res) => {
  const list = await prisma.equivalent.findMany({
    orderBy: { principeActif: "asc" },
  });
  res.json(list.filter((row) => isValidEquivalentName(row.nomMedicament)));
});

router.post("/", async (req, res) => {
  const parsed = equivSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (!isValidEquivalentName(parsed.data.nomMedicament)) {
    return res.status(400).json({
      error:
        "Nom d'équivalent invalide (évitez les packs/compositions avec accolades).",
    });
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
