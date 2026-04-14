import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

const router = Router();

const scanSchema = z.object({
  code_barre: z.string().trim().min(2).max(120),
});

function pickFirstText(value) {
  if (Array.isArray(value) && value.length > 0) return String(value[0]).trim();
  if (typeof value === "string") return value.trim();
  return "";
}

async function fetchOpenFda(searchExpression) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(searchExpression)}&limit=1`;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    const first = body?.results?.[0];
    if (!first) return null;
    const openfda = first.openfda ?? {};
    const nom =
      pickFirstText(openfda.brand_name) ||
      pickFirstText(openfda.generic_name) ||
      pickFirstText(first.purpose) ||
      "";
    const principeActif =
      pickFirstText(openfda.substance_name) ||
      pickFirstText(first.active_ingredient) ||
      pickFirstText(openfda.generic_name) ||
      "";
    if (!nom && !principeActif) return null;
    return {
      nom: nom || "Médicament inconnu",
      principeActif: principeActif || "Principe actif non renseigné",
      dosage: "",
      source: "openfda",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

router.post("/", async (req, res) => {
  const parsed = scanSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const code = parsed.data.code_barre.replace(/\s+/g, "");

  const local = await prisma.medicament.findFirst({
    where: {
      OR: [
        { codeBarre: { equals: code } },
        { nom: { equals: code } },
        { nom: { contains: code } },
      ],
    },
    include: {
      lots: {
        where: { quantite: { gt: 0 } },
        orderBy: { dateExpiration: "asc" },
      },
    },
  });

  if (local) {
    return res.json({
      status: "local",
      code_barre: code,
      querySuggestion: local.nom,
      medicament: {
        id: local.id,
        nom: local.nom,
        principeActif: local.principeActif,
        dosage: local.dosage,
        quantite: (local.lots ?? []).reduce((sum, lot) => sum + lot.quantite, 0),
        dateExpiration: local.lots?.[0]?.dateExpiration ?? null,
      },
      message: "Médicament trouvé dans la base locale",
    });
  }

  const searchCandidates = [
    `openfda.product_ndc:${code}`,
    `openfda.package_ndc:${code}`,
    code,
  ];

  let external = null;
  for (const expression of searchCandidates) {
    external = await fetchOpenFda(expression);
    if (external) break;
  }

  if (external) {
    return res.json({
      status: "external",
      code_barre: code,
      querySuggestion: external.nom,
      medicament: external,
      message: "Résultat récupéré via OpenFDA",
    });
  }

  return res.json({
    status: "not_found",
    code_barre: code,
    querySuggestion: code,
    medicament: null,
    message: "Aucun résultat trouvé. Utilisez la recherche manuelle.",
  });
});

export default router;
