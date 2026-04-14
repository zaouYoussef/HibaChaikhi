import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

const router = Router();

const scanSchema = z.object({
  code_barre: z.string().trim().min(2).max(120),
});

function decodeEntities(text) {
  return String(text ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&eacute;/gi, "e")
    .replace(/&egrave;/gi, "e")
    .replace(/&agrave;/gi, "a")
    .replace(/&ccedil;/gi, "c");
}

function cleanHtmlText(input) {
  return decodeEntities(
    String(input ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function extractFirst(html, regex) {
  const m = html.match(regex);
  return m?.[1] ? cleanHtmlText(m[1]) : "";
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

    const nom = extractFirst(
      html,
      /<div[^>]*class=["'][^"']*single\s+single-medicament[^"']*["'][^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i
    );
    if (!nom) return null;

    const principeActif = extractFirst(
      html,
      /<tr[^>]*class=["'][^"']*field-composition[^"']*["'][^>]*>[\s\S]*?<[^>]*class=["'][^"']*value[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i
    );
    const presentation = extractFirst(
      html,
      /<tr[^>]*class=["'][^"']*field-presentation[^"']*["'][^>]*>[\s\S]*?<[^>]*class=["'][^"']*value[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i
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
