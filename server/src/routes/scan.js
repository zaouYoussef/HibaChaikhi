import { Router } from "express";
import { z } from "zod";
import { load } from "cheerio";
import { prisma } from "../lib/prisma.js";

const router = Router();

const scanSchema = z.object({
  code_barre: z.string().trim().min(2).max(120),
});

function cleanText(input) {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function isBarcodeLike(value, barcode) {
  const raw = String(value ?? "").trim();
  if (!raw) return true;
  const normalized = raw.replace(/\s+/g, "");
  if (normalized === barcode) return true;
  if (/^\d{6,}$/.test(normalized)) return true;
  return false;
}

async function fetchMedicamentsMoroccoByBarcode(barcode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  const url = `https://medicament.ma/?choice=barcode&s=${encodeURIComponent(barcode)}`;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "caravane-medicale/1.0",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = load(html);
    const ogTitle = cleanText($('meta[property="og:title"]').attr("content"))
      .replace(/\s+-\s*Medicament\.ma\s*$/i, "")
      .replace(/^Recherche de\s*/i, "")
      .replace(/^Recherche\s*-\s*/i, "")
      .trim();
    const nom = cleanText($(".single.single-medicament > h3").first().text()) || ogTitle;
    if (!nom || isBarcodeLike(nom, barcode)) return null;
    const lowerNom = nom.toLowerCase();
    if (
      lowerNom.includes("page non trouvee") ||
      lowerNom.includes("médicament non trouvé") ||
      lowerNom.includes("medicament non trouve") ||
      lowerNom.includes("suggestions")
    ) {
      return null;
    }

    const principeActif = cleanText(
      $("tr.field-composition > .value").first().text()
    );
    const presentation = cleanText(
      $("tr.field-presentation > .value").first().text()
    );

    return {
      nom,
      principeActif: principeActif || "Principe actif non renseigné",
      dosage: presentation || "",
      source: "medicaments_morocco",
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

  const moroccoApi = await fetchMedicamentsMoroccoByBarcode(code);
  if (moroccoApi) {
    return res.json({
      status: "external",
      code_barre: code,
      querySuggestion: moroccoApi.nom,
      medicament: moroccoApi,
      message: "Résultat récupéré via medicament.ma",
    });
  }

  return res.json({
    status: "not_found",
    code_barre: code,
    querySuggestion: code,
    medicament: null,
    message: "Aucun résultat trouvé sur medicament.ma. Utilisez la saisie manuelle.",
  });
});

export default router;
