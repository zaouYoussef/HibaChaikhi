import { Router } from "express";
import { z } from "zod";
import { load } from "cheerio";
import { createWorker } from "tesseract.js";
import * as XLSX from "xlsx";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import { prisma } from "../lib/prisma.js";
import {
  getDataTxtSourcePaths,
  readDataTxtCatalogSafe,
} from "../lib/dataTxtCatalog.js";

const router = Router();

const scanSchema = z.object({
  code_barre: z.string().trim().min(2).max(120),
});
const imageScanSchema = z.object({
  imageBase64: z.string().min(100),
});

let ocrWorkerPromise = null;
let taawidatyCache = {
  expiresAt: 0,
  rows: [],
};
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRootDir = path.resolve(__dirname, "..", "..", "..");
const serverRootDir = path.resolve(__dirname, "..", "..");
const unifiedCatalogPaths = [
  path.resolve(projectRootDir, "catalog-local-unified.json"),
  path.resolve(serverRootDir, "catalog-local-unified.json"),
];
const dataTxtPaths = getDataTxtSourcePaths(
  getCatalogBaseDirs(),
  process.env.CATALOG_DATA_TXT_PATHS
);

function getCatalogBaseDirs() {
  const fromEnv = String(process.env.CATALOG_BASE_DIRS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
  const bases = [projectRootDir, serverRootDir, process.cwd(), ...fromEnv].filter(Boolean);
  return [...new Set(bases)];
}

function cleanText(input) {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function isScanDebugEnabled() {
  return process.env.DEBUG_SCAN === "1";
}

function createScanLogger(reqId) {
  return (event, details = {}) => {
    if (!isScanDebugEnabled()) return;
    const safe = { ...details };
    if (typeof safe.apiKey === "string") delete safe.apiKey;
    console.log(`[scan:image][${reqId}] ${event}`, safe);
  };
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

function normalizeCode(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const digitsOnly = raw.replace(/\D+/g, "");
  if (digitsOnly.length >= 6) return digitsOnly;
  return raw.replace(/[^a-zA-Z0-9]+/g, "").toUpperCase();
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

function splitNameAndDosage(rawLine) {
  const line = cleanText(rawLine);
  if (!line) return { nom: "", dosage: "" };
  const dosage =
    extractDosageCandidates(line)[0] ||
    cleanText(
      line.match(/\b\d+(?:[.,]\d+)?\s?(?:mg|g|mcg|µg|ml|ui|iu|mui|%)\b/i)?.[0]
    );
  if (!dosage) return { nom: line, dosage: "" };
  const idx = line.toLowerCase().indexOf(dosage.toLowerCase());
  if (idx <= 0) return { nom: line, dosage };
  const nom = cleanText(line.slice(0, idx)).replace(/[-,;:\s]+$/g, "");
  return { nom, dosage };
}

function getTaawidatySourceUrls() {
  const bases = getCatalogBaseDirs();
  const defaults = bases.flatMap((baseDir) => [
    path.resolve(baseDir, "medications-cnops.json"),
    path.resolve(baseDir, "medications-cnss.json"),
    path.resolve(baseDir, "allmeds.json"),
  ]);
  const configured = String(process.env.CATALOG_JSON_PATHS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  // Always merge defaults + configured paths to maximize local coverage.
  return [...new Set([...defaults, ...configured])];
}

function getOdooSourceUrls() {
  const bases = getCatalogBaseDirs();
  const defaults = bases.flatMap((baseDir) => [
    path.resolve(baseDir, "medicaments.xlsx"),
    path.resolve(baseDir, "ref-des-medicaments-cnops-2014 (1) (1).xlsx"),
  ]);
  const configured = String(process.env.CATALOG_XLSX_PATHS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  // Always merge defaults + configured paths to maximize local coverage.
  return [...new Set([...defaults, ...configured])];
}

async function getPdfSourceUrls() {
  const configured = String(process.env.CATALOG_PDF_PATHS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (configured.length > 0) {
    return [...new Set(configured)];
  }
  const bases = getCatalogBaseDirs();
  const out = [];
  for (const baseDir of bases) {
    try {
      const names = await readdir(baseDir);
      out.push(
        ...names
          .filter((name) => name.toLowerCase().endsWith(".pdf"))
          .map((name) => path.resolve(baseDir, name))
      );
    } catch {
      // ignore missing directories
    }
  }
  return [...new Set(out)];
}

async function readJsonFileSafe(filePath) {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readUnifiedCatalogSafe() {
  const mergedRows = [];
  const dataRows = await readDataTxtCatalogSafe(dataTxtPaths);
  if (dataRows.length > 0) mergedRows.push(...dataRows);
  const configured = String(process.env.CATALOG_UNIFIED_PATHS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const candidatePaths = [...new Set([...configured, ...unifiedCatalogPaths])];
  for (const filePath of candidatePaths) {
    const content = await readJsonFileSafe(filePath);
    if (!Array.isArray(content) || content.length === 0) continue;
    const normalized = content
      .map((entry) => ({
        code: normalizeCode(entry?.code),
        fullName: cleanText(entry?.fullName || entry?.nom),
        nom: cleanText(entry?.nom),
        dosage: cleanText(entry?.dosage),
        principeActif: cleanText(entry?.principeActif),
        equivalents: [],
      }))
      .filter((entry) => entry.nom || entry.fullName);
    if (normalized.length > 0) mergedRows.push(...normalized);
  }
  if (mergedRows.length === 0) return [];

  const dedup = new Map();
  for (const row of mergedRows) {
    const key = row.code
      ? `code:${normalizeCode(row.code)}`
      : `${normalizeText(row.nom)}|${normalizeText(row.dosage)}|${normalizeText(
          row.principeActif
        )}`;
    if (!key) continue;
    const existing = dedup.get(key);
    if (!existing || scoreCatalogRowQuality(row) > scoreCatalogRowQuality(existing)) {
      dedup.set(key, row);
      continue;
    }
    if (
      Array.isArray(existing.equivalents) &&
      existing.equivalents.length === 0 &&
      Array.isArray(row.equivalents) &&
      row.equivalents.length > 0
    ) {
      existing.equivalents = row.equivalents;
    }
  }
  return [...dedup.values()];
}

async function readArrayBufferFileSafe(filePath) {
  try {
    const buf = await readFile(filePath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    return null;
  }
}

async function readTextFileSafe(filePath) {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function readPdfTextSafe(filePath) {
  try {
    const buf = await readFile(filePath);
    const parser = new PDFParse({ data: buf });
    try {
      const parsed = await parser.getText();
      return String(parsed?.text ?? "");
    } finally {
      await parser.destroy();
    }
  } catch {
    return "";
  }
}

function getRmmgSourceUrls() {
  const configured = String(process.env.CATALOG_RMMG_PATHS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  const bases = getCatalogBaseDirs();
  return [...new Set(bases.flatMap((baseDir) => [
    path.resolve(baseDir, "rmmg-ammps-2026.txt"),
    path.resolve(baseDir, "rmmg-ammps-2026.pdf.txt"),
  ]))];
}

function parseRmmgText(rawText) {
  const lines = String(rawText ?? "")
    .split(/\r?\n/g)
    .map((line) => cleanText(line))
    .filter(Boolean);
  if (lines.length === 0) return [];

  const entries = [];
  const codeRegex = /(\d{8,14})\s*$/;
  let currentGroup = "";
  let currentGroupPrinciple = "";
  let currentGroupDosage = "";
  let currentRowBuffer = "";

  const flushRowIfComplete = (rowText) => {
    const compactRow = cleanText(rowText);
    if (!compactRow) return;
    const codeMatch = compactRow.match(codeRegex);
    if (!codeMatch) return;

    const code = normalizeCode(codeMatch[1]);
    let core = cleanText(compactRow.replace(codeRegex, ""));
    core = core.replace(/^(BS|P|G|I)\s+/i, "");
    if (!core || !code) return;

    const parsedName = splitNameAndDosage(core);
    const nom = cleanText(parsedName.nom || core);
    const dosage = cleanText(parsedName.dosage || currentGroupDosage);
    const principeActif = cleanText(currentGroupPrinciple);
    if (!nom) return;

    entries.push({
      code,
      fullName: cleanText(core),
      nom,
      dosage,
      principeActif,
    });
  };

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (
      lower.startsWith("répertoire marocain des médicaments génériques") ||
      lower.startsWith("https://ammps.sante.gov.ma/") ||
      lower.startsWith("page ")
    ) {
      continue;
    }

    const groupMatch = line.match(/^groupe générique\s*:\s*(.+)$/i);
    if (groupMatch) {
      currentGroup = cleanText(groupMatch[1]);
      const parsedGroup = splitNameAndDosage(currentGroup);
      currentGroupPrinciple = cleanText(parsedGroup.nom || currentGroup);
      currentGroupDosage = cleanText(parsedGroup.dosage);
      currentRowBuffer = "";
      continue;
    }

    if (
      /^voie d['’]administration\s*:/i.test(line) ||
      /^spécialité pharmaceutique/i.test(line) ||
      /^_{3,}$/.test(line)
    ) {
      continue;
    }

    const startsLikeRow = /^(BS|P|G|I)\s+/i.test(line);
    const hasBarcode = codeRegex.test(line);

    if (startsLikeRow && currentRowBuffer && !hasBarcode) {
      currentRowBuffer = line;
      continue;
    }
    if (startsLikeRow && !currentRowBuffer) {
      currentRowBuffer = line;
      if (hasBarcode) {
        flushRowIfComplete(currentRowBuffer);
        currentRowBuffer = "";
      }
      continue;
    }

    if (currentRowBuffer) {
      currentRowBuffer = `${currentRowBuffer} ${line}`.trim();
      if (codeRegex.test(currentRowBuffer)) {
        flushRowIfComplete(currentRowBuffer);
        currentRowBuffer = "";
      }
      continue;
    }

    // Some rows may start directly without marker in malformed exports.
    if (hasBarcode && currentGroup) {
      flushRowIfComplete(line);
    }
  }

  if (currentRowBuffer) {
    flushRowIfComplete(currentRowBuffer);
  }

  return entries;
}

function parseAnamGuideText(rawText) {
  const lines = String(rawText ?? "")
    .split(/\r?\n/g)
    .map((line) => cleanText(line))
    .filter(Boolean);
  if (lines.length === 0) return [];

  const headerPatterns = [
    /^code ean/i,
    /^classement par/i,
    /^guide des medicaments/i,
    /^assurance maladie obligatoire/i,
    /^version\s*:/i,
    /^anam\s*-/i,
    /^\d+\s*\/\s*\d+$/,
  ];
  const looksLikeHeader = (line) => {
    const normalized = normalizeForMatch(line);
    if (!normalized) return true;
    return headerPatterns.some((rx) => rx.test(normalized));
  };

  const eanStartRegex = /^(\d{13})\b\s*(.*)$/;
  const presentationRegex =
    /\b\d+\s+(?:boite|flacon|bidon|ampoule|sachet|seringue|poche|tube|ovule|gelule|comprime|capsule|patch|cartouche|stylo|recipient|suppositoire|dose|kit|flexipoche)\b/i;
  const formRegex =
    /\b(comprime|gelule|capsule|poudre|solution|suspension|sirop|collyre|creme|pommade|ovule|suppositoire|granule|lyophilisat|dispositif|concentre|emulsion|gouttes|spray|aerosol|inhalation|injectable|perfusion|pulverisation|lotion)\b/i;
  const dosageRegex =
    /\b\d+(?:[.,]\d+)?\s?(?:mg|g|mcg|ug|µg|ml|ui|iu|mui|%)\b(?:\s*\/\s*\d+(?:[.,]\d+)?\s?(?:mg|g|mcg|ug|µg|ml|ui|iu|mui|%))?/i;

  const entries = [];
  let current = null;

  const flushCurrent = () => {
    if (!current?.code) return;
    const merged = cleanText(current.parts.join(" "));
    if (!merged) return;

    let core = merged;
    const presentationMatch = core.match(presentationRegex);
    if (presentationMatch?.index && presentationMatch.index > 0) {
      core = cleanText(core.slice(0, presentationMatch.index));
    }
    core = core.replace(/\s+[PG]\s*$/i, "").trim();

    const dosageMatch = core.match(dosageRegex);
    const dosage = cleanText(dosageMatch?.[0]);
    let beforeDosage = dosageMatch?.index
      ? cleanText(core.slice(0, dosageMatch.index))
      : core;
    beforeDosage = beforeDosage.replace(/\s+[aà]$/i, "").trim();

    const formMatch = beforeDosage.match(formRegex);
    if (formMatch?.index && formMatch.index > 0) {
      beforeDosage = cleanText(beforeDosage.slice(0, formMatch.index));
    }

    const nom = cleanText(beforeDosage || core);
    if (!nom) return;
    entries.push({
      code: normalizeCode(current.code),
      fullName: cleanText(core),
      nom,
      dosage,
      principeActif: "",
    });
  };

  for (const line of lines) {
    if (looksLikeHeader(line)) continue;
    const eanMatch = line.match(eanStartRegex);
    if (eanMatch) {
      flushCurrent();
      current = { code: eanMatch[1], parts: [cleanText(eanMatch[2])] };
      continue;
    }
    if (!current) continue;
    current.parts.push(line);
  }
  flushCurrent();
  return entries;
}

function scoreCatalogRowQuality(row) {
  const nameLen = cleanText(row?.nom).length;
  const principleLen = cleanText(row?.principeActif).length;
  const dosageLen = cleanText(row?.dosage).length;
  return (
    (principleLen > 1 ? 30 : 0) +
    (dosageLen > 1 ? 15 : 0) +
    (nameLen > 0 ? Math.max(1, 20 - Math.floor(nameLen / 8)) : 0)
  );
}

function readFieldFromRow(row, aliases) {
  if (!row || typeof row !== "object") return "";
  const entries = Object.entries(row);
  for (const [key, value] of entries) {
    const nk = normalizeForMatch(key);
    if (!nk) continue;
    if (aliases.some((alias) => nk === normalizeForMatch(alias))) {
      return cleanText(value);
    }
  }
  return "";
}

function parseMedicationRow(row) {
  const code = normalizeCode(
    readFieldFromRow(row, [
      "code",
      "id",
      "cip",
      "ean13",
      "ean",
      "barcode",
      "code barre",
      "code_barre",
    ])
  );
  const rawName = cleanText(
    readFieldFromRow(row, [
      "name",
      "nom",
      "medicament",
      "nom medicament",
      "nom_medicament",
      "specialite",
      "libelle",
    ])
  );
  const dosage = cleanText(
    readFieldFromRow(row, ["dosage", "presentation", "forme", "unit_dosage", "unite dosage"])
  );
  const principle = cleanText(
    readFieldFromRow(row, ["composition", "principe actif", "principe_actif", "dci"])
  );
  const fullName = cleanText(
    rawName ||
      [rawName, dosage, readFieldFromRow(row, ["presentation", "forme"])]
        .filter(Boolean)
        .join(" ")
  );
  if (!fullName) return null;
  const parsed = splitNameAndDosage(fullName);
  return {
    code,
    fullName,
    nom: parsed.nom || rawName || fullName,
    dosage: parsed.dosage || dosage || "",
    principeActif: principle,
  };
}

function parseXlsxMedications(arrayBuffer) {
  try {
    const workbook = XLSX.read(Buffer.from(arrayBuffer), { type: "buffer" });
    const firstSheetName = workbook?.SheetNames?.[0];
    if (!firstSheetName) return [];
    const sheet = workbook.Sheets[firstSheetName];
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    return rows.map(parseMedicationRow).filter(Boolean);
  } catch {
    return [];
  }
}

async function loadTaawidatyCatalog() {
  const now = Date.now();
  if (taawidatyCache.rows.length > 0 && taawidatyCache.expiresAt > now) {
    return taawidatyCache.rows;
  }
  const unifiedRows = await readUnifiedCatalogSafe();
  if (unifiedRows.length > 0) {
    taawidatyCache = {
      rows: unifiedRows,
      expiresAt: now + 12 * 60 * 60 * 1000,
    };
    return taawidatyCache.rows;
  }
  const taawidatyUrls = getTaawidatySourceUrls();
  const taawidatyBatches = await Promise.all(
    taawidatyUrls.map((filePath) => readJsonFileSafe(filePath))
  );
  const taawidatyRows = taawidatyBatches
    .flatMap((batch) => (Array.isArray(batch) ? batch : []))
    .map((entry) => parseMedicationRow(entry))
    .map((entry) => {
      if (!entry) return null;
      return {
        code: normalizeCode(entry?.code),
        fullName: cleanText(entry?.fullName || entry?.nom),
        nom: cleanText(entry?.nom) || splitNameAndDosage(entry?.fullName).nom || "",
        dosage: cleanText(entry?.dosage),
        principeActif: cleanText(entry?.principeActif),
      };
    })
    .filter(Boolean);

  const odooUrls = getOdooSourceUrls();
  const odooBuffers = await Promise.all(
    odooUrls.map((filePath) => readArrayBufferFileSafe(filePath))
  );
  const odooRows = odooBuffers
    .flatMap((buf) => (buf ? parseXlsxMedications(buf) : []))
    .map((entry) => {
      const fullName = cleanText(entry?.fullName || entry?.nom);
      if (!fullName) return null;
      return {
        code: normalizeCode(entry?.code),
        fullName,
        nom: cleanText(entry?.nom) || splitNameAndDosage(fullName).nom || fullName,
        dosage: cleanText(entry?.dosage),
        principeActif: cleanText(entry?.principeActif),
      };
    })
    .filter(Boolean);

  const rmmgUrls = getRmmgSourceUrls();
  const rmmgTexts = await Promise.all(rmmgUrls.map((filePath) => readTextFileSafe(filePath)));
  const rmmgRows = rmmgTexts.flatMap((text) => parseRmmgText(text));

  const pdfUrls = await getPdfSourceUrls();
  const pdfTexts = await Promise.all(pdfUrls.map((filePath) => readPdfTextSafe(filePath)));
  const pdfRows = pdfTexts.flatMap((text) => [
    ...parseRmmgText(text),
    ...parseAnamGuideText(text),
  ]);

  const rows = [...taawidatyRows, ...odooRows, ...rmmgRows, ...pdfRows];

  const dedup = new Map();
  for (const row of rows) {
    const key = `${normalizeText(row.code)}|${normalizeText(row.fullName)}`;
    if (!dedup.has(key)) dedup.set(key, row);
  }
  taawidatyCache = {
    rows: [...dedup.values()],
    expiresAt: now + 12 * 60 * 60 * 1000,
  };
  return taawidatyCache.rows;
}

async function lookupTaawidatyByCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const catalog = await loadTaawidatyCatalog();
  const candidates = catalog
    .filter((row) => row.code && row.code === normalized)
    .sort((a, b) => scoreCatalogRowQuality(b) - scoreCatalogRowQuality(a));
  return candidates[0] || null;
}

async function inferFromTaawidatyCatalog(ocrText) {
  const normalizedOcr = normalizeForMatch(ocrText);
  const ocrTokens = new Set(tokenize(ocrText));
  if (!normalizedOcr || ocrTokens.size === 0) return null;
  const dosageCandidates = extractDosageCandidates(ocrText).map((d) =>
    normalizeForMatch(d)
  );
  const catalog = await loadTaawidatyCatalog();
  let best = null;
  let bestScore = 0;
  for (const item of catalog) {
    const nameTokens = tokenize(item.nom);
    if (nameTokens.length === 0) continue;
    const tokenHits = nameTokens.reduce(
      (sum, token) => sum + (ocrTokens.has(token) ? 1 : 0),
      0
    );
    const tokenRatio = tokenHits / Math.max(nameTokens.length, 1);
    const itemNameNorm = normalizeForMatch(item.nom);
    const itemDosageNorm = normalizeForMatch(item.dosage);

    let score = tokenHits * 2;
    if (itemNameNorm && normalizedOcr.includes(itemNameNorm)) score += 10;
    if (tokenRatio >= 0.6) score += 6;
    if (
      itemDosageNorm &&
      dosageCandidates.some(
        (cand) =>
          cand &&
          (cand.includes(itemDosageNorm) || itemDosageNorm.includes(cand))
      )
    ) {
      score += 6;
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (!best || bestScore < 8) return null;
  return {
    status: "partial",
    confidence: Math.min(0.86, Number((bestScore / 22).toFixed(2))),
    medicament: {
      nom: best.nom,
      principeActif: "",
      dosage: best.dosage || extractDosageCandidates(ocrText)[0] || "",
      source: "vision_ocr_taawidaty",
    },
    equivalents: [],
    message:
      "Nom détecté via catalogue TAAWIDATY. Vérifiez puis complétez si nécessaire.",
  };
}

function pickBestMedicationLine(ocrText) {
  const lines = normalizeOcrLines(ocrText);
  const filtered = lines
    .filter((line) => /[a-zA-Z]/.test(line))
    .filter((line) => !/notice|posologie|composition|lot|exp|péremption|fabricant/i.test(line))
    .map((line) => {
      const hasDosage = extractDosageCandidates(line).length > 0;
      const words = line.split(/\s+/).filter(Boolean).length;
      const looksUpper = /[A-Z]{3,}/.test(line);
      let score = 0;
      if (hasDosage) score += 8;
      if (looksUpper) score += 2;
      if (words >= 1 && words <= 8) score += 2;
      if (line.length >= 4 && line.length <= 80) score += 2;
      return { line, score };
    })
    .sort((a, b) => b.score - a.score);
  return filtered[0]?.line || "";
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

async function extractMedicationWithVisionApi(imageBase64, log = () => {}) {
  const apiKey = process.env.VISION_API_KEY?.trim();
  if (
    !apiKey ||
    apiKey === "TA_NOUVELLE_CLE" ||
    apiKey.toLowerCase().includes("nouvelle_cle")
  ) {
    log("vision_skipped_invalid_key");
    return null;
  }
  const configuredModel = process.env.VISION_MODEL?.trim() || "gemini-2.5-flash";
  const customEndpoint = process.env.VISION_API_URL?.trim();
  const modelCandidates = [
    configuredModel,
    "gemini-2.5-flash",
    "gemini-1.5-flash-latest",
    "gemini-2.0-flash",
  ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);
  const { mimeType, base64Data } = splitDataUrl(imageBase64);
  if (!base64Data) {
    log("vision_skipped_no_base64");
    return null;
  }

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
Regles strictes:
- confidence entre 0 et 1
- pas de texte hors JSON
- si incertain: confidence < 0.55 et champs vides
- nom court (max 7 mots).`;

    for (const model of customEndpoint ? [configuredModel] : modelCandidates) {
      const endpoint =
        customEndpoint ||
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          model
        )}:generateContent?key=${encodeURIComponent(apiKey)}`;
      log("vision_request_start", {
        model,
        endpointHost: (() => {
          try {
            return new URL(endpoint).host;
          } catch {
            return "invalid-url";
          }
        })(),
        mimeType,
        base64Length: base64Data.length,
      });

      // eslint-disable-next-line no-await-in-loop
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

      if (!res.ok) {
        // eslint-disable-next-line no-await-in-loop
        const body = await res.text().catch(() => "");
        log("vision_http_error", {
          model,
          status: res.status,
          bodyPreview: body.slice(0, 200),
        });
        if (!customEndpoint && res.status === 404) {
          continue;
        }
        return null;
      }

      // eslint-disable-next-line no-await-in-loop
      const payload = await res.json();
      const text = (payload?.candidates ?? [])
        .flatMap((c) => c?.content?.parts ?? [])
        .map((p) => p?.text ?? "")
        .join("\n")
        .trim();
      const parsed = extractJsonObject(text);
      if (!parsed) {
        log("vision_json_parse_failed", {
          model,
          rawPreview: text.slice(0, 200),
        });
        continue;
      }

      const nom = cleanText(parsed.nom);
      const principeActif = cleanText(parsed.principeActif);
      const dosage = cleanText(parsed.dosage);
      const confidence = Number(parsed.confidence ?? 0);

      if (!isLikelyMedicationName(nom)) {
        log("vision_rejected_name", { model, nom });
        continue;
      }
      if (!dosage || dosage.length < 2) {
        log("vision_rejected_dosage", { model, dosage });
        continue;
      }
      if (!(confidence >= 0.55)) {
        log("vision_rejected_confidence", { model, confidence });
        continue;
      }

      log("vision_success", {
        model,
        nom,
        principeActif,
        dosage,
        confidence,
      });

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
    }
    return null;
  } catch (err) {
    log("vision_exception", {
      name: err?.name,
      message: err?.message,
    });
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

function isValidEquivalentName(name) {
  const value = cleanText(name);
  if (!value) return false;
  if (value.length < 3 || value.length > 120) return false;
  if (value.includes("{") || value.includes("}")) return false;
  if (/\bpack\b/i.test(value)) return false;
  if (value.split("/").length > 2) return false;
  return true;
}

function looksUnknownPrinciple(value) {
  const v = normalizeText(value);
  if (!v) return true;
  return (
    v.includes("non renseigne") ||
    v.includes("non renseigné") ||
    v.includes("inconnu")
  );
}

function normalizeDosageToken(value) {
  return cleanText(value).replace(/\s+/g, "").toLowerCase();
}

function splitNameAndStrength(value) {
  const raw = cleanText(value);
  if (!raw) return { name: "", dosage: "" };
  const dosage = extractDosageCandidates(raw)[0] || "";
  if (!dosage) return { name: raw, dosage: "" };
  const idx = raw.toLowerCase().indexOf(dosage.toLowerCase());
  if (idx <= 0) return { name: raw, dosage };
  return {
    name: cleanText(raw.slice(0, idx)).replace(/[-,;:\s]+$/g, ""),
    dosage,
  };
}

async function fetchPrincipleFromRxNorm({ nom, dosage }) {
  const query = cleanText(nom);
  if (query.length < 2) return "";
  const dosageToken = normalizeDosageToken(dosage);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `https://rxnav.nlm.nih.gov/REST/drugs.json?name=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return "";
    const body = await res.json();
    const groups = body?.drugGroup?.conceptGroup ?? [];
    const concepts = groups.flatMap((g) => g?.conceptProperties ?? []);
    let fallback = "";
    for (const concept of concepts) {
      const label = cleanText(concept?.name);
      if (!label) continue;
      const parsed = splitNameAndStrength(label);
      const candidatePrinciple = cleanText(parsed.name);
      if (!candidatePrinciple) continue;
      if (!fallback) fallback = candidatePrinciple;
      if (!dosageToken) return candidatePrinciple;
      if (
        normalizeDosageToken(parsed.dosage) === dosageToken ||
        normalizeText(label).includes(normalizeText(dosage))
      ) {
        return candidatePrinciple;
      }
    }
    return fallback;
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPrincipleFromOpenFda({ nom }) {
  const query = cleanText(nom);
  if (query.length < 2) return "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const escaped = query.replace(/"/g, '\\"');
    const searches = [
      `openfda.brand_name:"${escaped}"`,
      `openfda.brand_name:${escaped}*`,
      `openfda.generic_name:${escaped}*`,
    ];
    for (const search of searches) {
      const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(
        search
      )}&limit=3`;
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) continue;
      // eslint-disable-next-line no-await-in-loop
      const body = await res.json();
      const rows = Array.isArray(body?.results) ? body.results : [];
      for (const row of rows) {
        const pa = cleanText(row?.openfda?.generic_name?.[0]);
        if (pa) return pa;
        const substances = row?.active_ingredient;
        if (Array.isArray(substances) && substances.length > 0) {
          const first = splitNameAndStrength(substances[0]);
          if (first.name) return first.name;
        }
      }
    }
    return "";
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichPrincipleFromWeb(medicament) {
  const current = cleanText(medicament?.principeActif);
  if (current && !looksUnknownPrinciple(current)) {
    return medicament;
  }
  const nom = cleanText(medicament?.nom);
  const dosage = cleanText(medicament?.dosage);
  if (!nom) return medicament;

  const fromRxNorm = await fetchPrincipleFromRxNorm({ nom, dosage });
  if (fromRxNorm) {
    return {
      ...medicament,
      principeActif: fromRxNorm,
      source: `${medicament?.source || "external"}+rxnorm_pa`,
    };
  }
  const fromOpenFda = await fetchPrincipleFromOpenFda({ nom });
  if (fromOpenFda) {
    return {
      ...medicament,
      principeActif: fromOpenFda,
      source: `${medicament?.source || "external"}+openfda_pa`,
    };
  }
  return medicament;
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
      .filter((row) => isValidEquivalentName(row.nom))
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

function buildTextFromWords(words, minConfidence) {
  const kept = (words ?? [])
    .filter((w) => Number(w?.confidence ?? 0) >= minConfidence)
    .sort((a, b) => {
      const byLine = Number(a?.line_num ?? 0) - Number(b?.line_num ?? 0);
      if (byLine !== 0) return byLine;
      return Number(a?.word_num ?? 0) - Number(b?.word_num ?? 0);
    });
  const lines = new Map();
  for (const w of kept) {
    const key = `${w?.block_num ?? 0}-${w?.par_num ?? 0}-${w?.line_num ?? 0}`;
    const value = cleanText(w?.text);
    if (!value) continue;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(value);
  }
  return cleanText(
    [...lines.values()]
      .map((parts) => parts.join(" "))
      .join("\n")
  );
}

function scoreOcrText(text, avgConfidence) {
  const normalized = cleanText(text);
  if (!normalized) return 0;
  const hasDosage = extractDosageCandidates(normalized).length > 0;
  const alphaCount = (normalized.match(/[a-zA-Z]/g) ?? []).length;
  const digitCount = (normalized.match(/\d/g) ?? []).length;
  let score = Number(avgConfidence || 0);
  if (hasDosage) score += 25;
  if (alphaCount >= 10) score += 10;
  if (digitCount >= 2) score += 5;
  if (normalized.length >= 18) score += 6;
  return score;
}

async function readTextFromBase64Image(imageBase64, log = () => {}) {
  const { base64Data: cleanBase64, dataUrl } = splitDataUrl(imageBase64);
  if (!cleanBase64) {
    log("ocr_skipped_no_base64");
    return "";
  }
  const estimatedBytes = Math.floor((cleanBase64.length * 3) / 4);
  if (estimatedBytes > 4 * 1024 * 1024) {
    log("ocr_rejected_image_too_large", { estimatedBytes });
    throw new Error("Image trop lourde (max 4 Mo).");
  }
  log("ocr_request_start", { estimatedBytes });
  const worker = await getOcrWorker();
  const minWordConfidence = Number(process.env.OCR_WORD_CONFIDENCE || 55);
  const passes = [
    { psm: "11", preserve_interword_spaces: "1" }, // sparse text
    { psm: "6", preserve_interword_spaces: "1" }, // single uniform block
    { psm: "4", preserve_interword_spaces: "1" }, // single column variable sizes
  ];
  let best = { text: "", score: 0, confidence: 0, psm: "default" };

  for (const pass of passes) {
    // eslint-disable-next-line no-await-in-loop
    await worker.setParameters(pass);
    // eslint-disable-next-line no-await-in-loop
    const { data } = await worker.recognize(dataUrl);
    const byWords = buildTextFromWords(data?.words, minWordConfidence);
    const merged = cleanText(byWords || data?.text);
    const avgConfidence = Number(data?.confidence ?? 0);
    const score = scoreOcrText(merged, avgConfidence);
    log("ocr_pass_done", {
      psm: pass.psm,
      avgConfidence,
      textLength: merged.length,
      score,
      preview: merged.slice(0, 120),
    });
    if (score > best.score) {
      best = { text: merged, score, confidence: avgConfidence, psm: pass.psm };
    }
  }

  log("ocr_success", {
    textLength: best.text.length,
    confidence: best.confidence,
    psm: best.psm,
    preview: best.text.slice(0, 120),
  });
  return best.text;
}

async function inferMedicationFromOcrText(ocrText) {
  const normalizedOcr = normalizeForMatch(ocrText);
  const ocrTokens = new Set(tokenize(ocrText));
  const dosageCandidates = extractDosageCandidates(ocrText).map(normalizeForMatch);
  const bestLine = pickBestMedicationLine(ocrText);
  const parsedLine = splitNameAndDosage(bestLine);
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
    if (principeNorm && normalizedOcr.includes(principeNorm)) score += 7;
    if (dosageNorm && normalizedOcr.includes(dosageNorm)) score += 6;
    if (tokenHits > 0 && nomTokens.length <= 2) score += 2;
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

  if (!best || bestScore < 6) {
    const principes = await prisma.medicament.findMany({
      select: { principeActif: true },
      distinct: ["principeActif"],
    });
    const matchedPrincipes = principes
      .map((p) => cleanText(p.principeActif))
      .filter(Boolean)
      .filter((pa) => normalizedOcr.includes(normalizeForMatch(pa)))
      .sort((a, b) => b.length - a.length);

    if (matchedPrincipes.length > 0) {
      const principle = matchedPrincipes[0];
      const candidate = await prisma.medicament.findFirst({
        where: { principeActif: { equals: principle } },
        orderBy: { nom: "asc" },
      });
      if (candidate) {
        return {
          status: "partial",
          confidence: 0.62,
          medicament: {
            id: candidate.id,
            nom: candidate.nom,
            principeActif: candidate.principeActif,
            dosage:
              extractDosageCandidates(ocrText)[0] || candidate.dosage || "",
            source: "vision_ocr_principe",
          },
          equivalents: [],
          message:
            "Principe actif détecté via OCR. Vérifiez le dosage avant enregistrement.",
        };
      }
    }

    if (parsedLine.nom && isLikelyMedicationName(parsedLine.nom)) {
      return {
        status: "partial",
        confidence: parsedLine.dosage ? 0.66 : 0.58,
        medicament: {
          nom: parsedLine.nom,
          principeActif: matchedPrincipes[0] || "",
          dosage: parsedLine.dosage || "",
          source: "vision_ocr_freeform",
        },
        equivalents: [],
        message:
          "Nom détecté via OCR local. Vérifiez/corrigez le principe actif et le dosage si nécessaire.",
      };
    }

    const taawidatyMatch = await inferFromTaawidatyCatalog(ocrText);
    if (taawidatyMatch?.medicament?.nom) {
      return taawidatyMatch;
    }

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

  const equivalents = equivalentsLocal
    .map((m) => ({
      nom: m.nom,
      principeActif: m.principeActif,
      dosage: m.dosage,
      source: "local",
    }))
    .slice(0, 8);

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
      principeActif,
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
      codeBarre: { equals: code },
    },
    include: {
      lots: {
        where: { quantite: { gt: 0 } },
        orderBy: { dateExpiration: "asc" },
      },
    },
  });
  const catalogHit = await lookupTaawidatyByCode(code);

  if (local) {
    const equivalents = (catalogHit?.equivalents ?? [])
      .filter((eq) => eq?.nom && eq?.code !== code)
      .slice(0, 10)
      .map((eq) => ({
        nom: eq.nom,
        codeBarres: eq.code || "",
        principeActif: cleanText(catalogHit?.principeActif),
        dosage: cleanText(catalogHit?.dosage),
        source: "data_txt",
      }));
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
      equivalents,
      message: "Médicament trouvé dans la base locale",
    });
  }

  if (catalogHit) {
    const equivalents = (catalogHit.equivalents ?? [])
      .filter((eq) => eq?.nom && eq?.code !== code)
      .slice(0, 10)
      .map((eq) => ({
        nom: eq.nom,
        codeBarres: eq.code || "",
        principeActif: cleanText(catalogHit.principeActif),
        dosage: cleanText(catalogHit.dosage),
        source: "data_txt",
      }));
    return res.json({
      status: "external",
      code_barre: code,
      querySuggestion: catalogHit.nom,
      medicament: {
        nom: catalogHit.nom,
        dosage: catalogHit.dosage || "",
        principeActif:
          cleanText(catalogHit.principeActif) || "Principe actif non renseigné",
        source: "local_catalog",
      },
      equivalents,
      message: "Résultat récupéré via data.txt (catalogue local fusionné)",
    });
  }

  return res.json({
    status: "not_found",
    code_barre: code,
    querySuggestion: code,
    medicament: null,
    message:
      "Aucun résultat trouvé dans la base locale et les fichiers catalogue.",
  });
});

router.post("/image", async (req, res) => {
  const parsed = imageScanSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  return res.status(410).json({
    status: "disabled",
    message:
      "Le lecteur caméra est désactivé. Utilisez uniquement le scan code-barres/QR.",
  });
});

export default router;
