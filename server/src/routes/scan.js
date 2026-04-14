import { Router } from "express";
import { z } from "zod";
import { load } from "cheerio";
import { createWorker } from "tesseract.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

const scanSchema = z.object({
  code_barre: z.string().trim().min(2).max(120),
});
const imageScanSchema = z.object({
  imageBase64: z.string().min(100),
});

let ocrWorkerPromise = null;

function cleanText(input) {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function normalizeForMatch(input) {
  return cleanText(input)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9%+/.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(input) {
  return normalizeForMatch(input)
    .split(" ")
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
}

function extractDosageCandidates(text) {
  const rx =
    /\b\d+(?:[.,]\d+)?\s?(?:mg|g|mcg|µg|ml|ui|iu|mui|%)\b(?:\s*\/\s*\d+(?:[.,]\d+)?\s?(?:mg|g|mcg|µg|ml|ui|iu|mui|%))?/gi;
  return [...String(text).matchAll(rx)].map((m) => cleanText(m[0]));
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker("fra+eng").catch((err) => {
      ocrWorkerPromise = null;
      throw err;
    });
  }
  return ocrWorkerPromise;
}

async function readTextFromBase64Image(imageBase64) {
  const cleanBase64 = String(imageBase64)
    .replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "")
    .trim();
  const imageBuffer = Buffer.from(cleanBase64, "base64");
  if (!imageBuffer.length) return "";
  if (imageBuffer.length > 4 * 1024 * 1024) {
    throw new Error("Image trop lourde (max 4 Mo).");
  }
  const worker = await getOcrWorker();
  const {
    data: { text },
  } = await worker.recognize(imageBuffer);
  return cleanText(text);
}

async function inferMedicationFromOcrText(ocrText) {
  const normalizedOcr = normalizeForMatch(ocrText);
  const ocrTokens = new Set(tokenize(ocrText));
  const dosageCandidates = extractDosageCandidates(ocrText).map(normalizeForMatch);
  const meds = await prisma.medicament.findMany({
    select: { id: true, nom: true, principeActif: true, dosage: true },
  });

  let best = null;
  let bestScore = 0;
  for (const med of meds) {
    const nomNorm = normalizeForMatch(med.nom);
    const principeNorm = normalizeForMatch(med.principeActif);
    const dosageNorm = normalizeForMatch(med.dosage);
    const nomTokens = tokenize(med.nom);
    const tokenHits = nomTokens.reduce(
      (sum, token) => sum + (ocrTokens.has(token) ? 1 : 0),
      0
    );

    let score = tokenHits * 2;
    if (nomNorm && normalizedOcr.includes(nomNorm)) score += 12;
    if (principeNorm && normalizedOcr.includes(principeNorm)) score += 4;
    if (dosageNorm && normalizedOcr.includes(dosageNorm)) score += 6;
    if (
      dosageCandidates.some(
        (cand) => cand && dosageNorm && (cand.includes(dosageNorm) || dosageNorm.includes(cand))
      )
    ) {
      score += 3;
    }

    if (score > bestScore) {
      bestScore = score;
      best = med;
    }
  }

  if (!best || bestScore < 8) {
    return {
      status: "not_found",
      confidence: 0,
      medicament: null,
      equivalents: [],
      message:
        "Texte détecté mais médicament non reconnu avec confiance suffisante.",
    };
  }

  const equivalentsLocal = await prisma.medicament.findMany({
    where: {
      id: { not: best.id },
      principeActif: { equals: best.principeActif },
    },
    select: { id: true, nom: true, principeActif: true, dosage: true },
    take: 5,
  });
  const equivalentsRef = await prisma.equivalent.findMany({
    where: { principeActif: { equals: best.principeActif } },
    select: { nomMedicament: true, principeActif: true },
    take: 5,
  });

  const equivalents = [
    ...equivalentsLocal.map((m) => ({
      nom: m.nom,
      principeActif: m.principeActif,
      dosage: m.dosage,
      source: "local",
    })),
    ...equivalentsRef.map((m) => ({
      nom: m.nomMedicament,
      principeActif: m.principeActif,
      dosage: "",
      source: "reference",
    })),
  ].slice(0, 8);

  return {
    status: "ok",
    confidence: Math.min(1, Number((bestScore / 20).toFixed(2))),
    medicament: {
      id: best.id,
      nom: best.nom,
      principeActif: best.principeActif,
      dosage: best.dosage,
      source: "vision_ocr",
    },
    equivalents,
    message: "Médicament identifié par lecture caméra (OCR + matching local).",
  };
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

router.post("/image", async (req, res) => {
  const parsed = imageScanSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const ocrText = await readTextFromBase64Image(parsed.data.imageBase64);
    if (!ocrText) {
      return res.json({
        status: "not_found",
        confidence: 0,
        medicament: null,
        equivalents: [],
        message: "Aucun texte lisible détecté. Rapprochez la caméra et stabilisez.",
      });
    }
    const inferred = await inferMedicationFromOcrText(ocrText);
    return res.json({
      ...inferred,
      ocrTextPreview: ocrText.slice(0, 240),
    });
  } catch (err) {
    return res.status(500).json({
      error:
        err?.message ||
        "Lecture image impossible pour le moment. Réessayez avec plus de lumière.",
    });
  }
});

export default router;
