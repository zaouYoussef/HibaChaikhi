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

function splitDataUrl(input) {
  const raw = String(input ?? "").trim();
  const m = raw.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!m) {
    return {
      mimeType: "image/jpeg",
      base64Data: raw.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, ""),
      dataUrl: raw.startsWith("data:image/") ? raw : `data:image/jpeg;base64,${raw}`,
    };
  }
  return {
    mimeType: m[1],
    base64Data: m[2],
    dataUrl: raw,
  };
}

function normalizeText(input) {
  return cleanText(input)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeOcrLines(input) {
  return String(input ?? "")
    .split(/\r?\n/g)
    .map((line) => cleanText(line))
    .filter(Boolean);
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

function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isLikelyMedicationName(value) {
  const v = cleanText(value);
  if (!v) return false;
  if (/^\d{5,}$/.test(v.replace(/\s+/g, ""))) return false;
  if (v.split(/\s+/).length > 7) return false;
  if (v.length < 3 || v.length > 64) return false;
  const lowered = v.toLowerCase();
  if (
    lowered.includes("notice") ||
    lowered.includes("posologie") ||
    lowered.includes("composition") ||
    lowered.includes("boite")
  ) {
    return false;
  }
  return /[a-zA-Z]/.test(v);
}

async function extractMedicationWithVisionApi(imageBase64) {
  const apiKey = process.env.VISION_API_KEY?.trim();
  if (
    !apiKey ||
    apiKey === "TA_NOUVELLE_CLE" ||
    apiKey.toLowerCase().includes("nouvelle_cle")
  ) {
    return null;
  }
  const model = process.env.VISION_MODEL?.trim() || "gemini-1.5-flash";
  const endpoint =
    process.env.VISION_API_URL?.trim() ||
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const { mimeType, base64Data } = splitDataUrl(imageBase64);
  if (!base64Data) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const prompt = `Analyse cette photo d'un médicament et retourne UNIQUEMENT un JSON valide:
{
  "nom": "nom commercial court",
  "principeActif": "principe actif ou vide",
  "dosage": "dosage ou forme ex: 500 mg, 1 g, 5 mg/mL",
  "confidence": 0.0
}
Règles strictes:
- confidence entre 0 et 1
- pas de texte hors JSON
- si incertain: confidence < 0.55 et champs vides
- nom court (max 7 mots).`;

    const res = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType || "image/jpeg",
                  data: base64Data,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const text = (payload?.candidates ?? [])
      .flatMap((c) => c?.content?.parts ?? [])
      .map((p) => p?.text ?? "")
      .join("\n")
      .trim();
    const parsed = extractJsonObject(text);
    if (!parsed) return null;

    const nom = cleanText(parsed.nom);
    const principeActif = cleanText(parsed.principeActif);
    const dosage = cleanText(parsed.dosage);
    const confidence = Number(parsed.confidence ?? 0);

    if (!isLikelyMedicationName(nom)) return null;
    if (!dosage || dosage.length < 2) return null;
    if (!(confidence >= 0.55)) return null;

    return {
      status: "ok",
      confidence: Math.min(1, Math.max(0, confidence)),
      medicament: {
        nom,
        principeActif,
        dosage,
        source: "vision_api",
      },
      equivalents: [],
      message: "Médicament détecté via API Vision IA.",
      ocrTextPreview: "",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function storeEquivalentReference(principeActif, nomMedicament) {
  const principe = cleanText(principeActif);
  const nom = cleanText(nomMedicament);
  if (!principe || !nom) return false;
  const existing = await prisma.equivalent.findFirst({
    where: { principeActif: principe, nomMedicament: nom },
    select: { id: true },
  });
  if (existing) return false;
  await prisma.equivalent.create({
    data: { principeActif: principe, nomMedicament: nom },
  });
  return true;
}

async function storeEquivalentReferencesBulk(principeActif, names) {
  const unique = [...new Set((names ?? []).map((n) => cleanText(n)).filter(Boolean))];
  let stored = 0;
  for (const name of unique) {
    // eslint-disable-next-line no-await-in-loop
    const created = await storeEquivalentReference(principeActif, name);
    if (created) stored += 1;
  }
  return stored;
}

function dedupeEquivalentItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items ?? []) {
    const key = `${normalizeText(item?.nom)}|${normalizeText(item?.principeActif)}|${normalizeText(item?.dosage)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function fetchRxNormWebEquivalents({ nom, principeActif }) {
  const query = cleanText(principeActif || nom);
  if (query.length < 2) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const url = `https://rxnav.nlm.nih.gov/REST/drugs.json?name=${encodeURIComponent(
      query
    )}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    const groups = data?.drugGroup?.conceptGroup ?? [];
    const concepts = groups.flatMap((g) => g?.conceptProperties ?? []);
    const results = concepts
      .map((c) => String(c?.name ?? "").trim())
      .filter(Boolean)
      .map((raw) => {
        const normalizedName = raw.replace(/acetaminophen/gi, "paracetamol").trim();
        const dosageMatch = normalizedName.match(
          /\b\d+(?:[.,]\d+)?\s?(?:mg|g|mcg|ug|µg|ml|iu|ui)\b/i
        );
        const dosage = dosageMatch ? dosageMatch[0] : "";
        const pa = cleanText(
          principeActif ||
            (dosageMatch
              ? normalizedName.slice(0, dosageMatch.index)
              : normalizedName.split(/\s+/).slice(0, 2).join(" "))
        );
        return {
          nom: normalizedName,
          principeActif: pa,
          dosage,
          source: "rxnorm_web",
        };
      })
      .filter((row) => normalizeText(row.nom) !== normalizeText(nom))
      .slice(0, 10);
    return dedupeEquivalentItems(results);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
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
  const { base64Data: cleanBase64, dataUrl } = splitDataUrl(imageBase64);
  if (!cleanBase64) return "";
  const estimatedBytes = Math.floor((cleanBase64.length * 3) / 4);
  if (estimatedBytes > 4 * 1024 * 1024) {
    throw new Error("Image trop lourde (max 4 Mo).");
  }
  const worker = await getOcrWorker();
  const {
    data: { text },
  } = await worker.recognize(dataUrl);
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

function pickFirstNonEmpty(record, keys) {
  for (const key of keys) {
    const value = cleanText(record?.[key]);
    if (value) return value;
  }
  return "";
}

async function fetchDataGovMaByBarcode(barcode) {
  const resourceId = process.env.DATAGOVMA_RESOURCE_ID?.trim();
  if (!resourceId) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const endpoint =
    process.env.DATAGOVMA_SEARCH_URL?.trim() ||
    "https://www.data.gov.ma/data/api/3/action/datastore_search";
  const url = new URL(endpoint);
  url.searchParams.set("resource_id", resourceId);
  url.searchParams.set("q", barcode);
  url.searchParams.set("limit", "1");

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) return null;
    const payload = await res.json();
    const record = payload?.result?.records?.[0];
    if (!record) return null;

    const nom = pickFirstNonEmpty(record, [
      "nom",
      "nom_commercial",
      "denomination",
      "denomination_commune",
      "specialite",
      "medicament",
      "libelle",
      "produit",
    ]);
    const principeActif = pickFirstNonEmpty(record, [
      "principe_actif",
      "dci",
      "substance_active",
      "composition",
      "ingredient_actif",
    ]);
    const dosage = pickFirstNonEmpty(record, [
      "dosage",
      "presentation",
      "forme_dosage",
      "concentration",
      "specification",
    ]);

    if (!nom || isBarcodeLike(nom, barcode)) return null;
    return {
      nom,
      principeActif: principeActif || "Principe actif non renseigné",
      dosage,
      source: "data_gov_ma",
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

  const dataGovApi = await fetchDataGovMaByBarcode(code);
  if (dataGovApi) {
    return res.json({
      status: "external",
      code_barre: code,
      querySuggestion: dataGovApi.nom,
      medicament: dataGovApi,
      message: "Résultat récupéré via data.gov.ma",
    });
  }

  return res.json({
    status: "not_found",
    code_barre: code,
    querySuggestion: code,
    medicament: null,
    message:
      "Aucun résultat trouvé sur medicament.ma / data.gov.ma. Utilisez la saisie manuelle.",
  });
});

router.post("/image", async (req, res) => {
  const parsed = imageScanSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    let ocrText = "";
    let inferred = await extractMedicationWithVisionApi(parsed.data.imageBase64);
    if (!inferred) {
      ocrText = await readTextFromBase64Image(parsed.data.imageBase64);
      if (!ocrText) {
        return res.json({
          status: "not_found",
          confidence: 0,
          medicament: null,
          equivalents: [],
          message:
            "Aucun texte lisible détecté. Essayez une image plus nette ou activez l'API Vision IA.",
        });
      }
      inferred = await inferMedicationFromOcrText(ocrText);
    }

    if (!inferred?.medicament?.nom || !inferred?.medicament?.dosage) {
      return res.json({
        status: "not_found",
        confidence: Number(inferred?.confidence ?? 0),
        medicament: null,
        equivalents: [],
        message:
          "Détection trop incertaine. Reprenez la photo plus près (nom + dosage visibles).",
        ocrTextPreview: ocrText.slice(0, 240),
      });
    }

    let equivalentStored = false;
    let equivalentsStoredFromWeb = 0;
    let mergedEquivalents = Array.isArray(inferred?.equivalents)
      ? [...inferred.equivalents]
      : [];
    if (inferred?.medicament?.nom && inferred?.medicament?.principeActif) {
      equivalentStored = await storeEquivalentReference(
        inferred.medicament.principeActif,
        inferred.medicament.nom
      );
    }
    if (inferred?.medicament?.nom) {
      const webEquivalents = await fetchRxNormWebEquivalents({
        nom: inferred.medicament.nom,
        principeActif: inferred.medicament.principeActif,
      });
      mergedEquivalents = dedupeEquivalentItems([
        ...mergedEquivalents,
        ...webEquivalents,
      ]).slice(0, 10);

      if (inferred?.medicament?.principeActif && webEquivalents.length > 0) {
        equivalentsStoredFromWeb = await storeEquivalentReferencesBulk(
          inferred.medicament.principeActif,
          webEquivalents.map((e) => e.nom)
        );
      }
    }
    return res.json({
      ...inferred,
      equivalents: mergedEquivalents,
      equivalentStored,
      equivalentsStoredFromWeb,
      ocrTextPreview: inferred?.ocrTextPreview || ocrText.slice(0, 240),
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
