import { Router } from "express";
import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { PDFParse } from "pdf-parse";
import { prisma } from "../lib/prisma.js";
import {
  getDataTxtSourcePaths,
  readDataTxtCatalogSafe,
} from "../lib/dataTxtCatalog.js";

const router = Router();
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
let referenceSuggestCache = {
  expiresAt: 0,
  rows: [],
};
const supportsInsensitiveMode = !String(process.env.DATABASE_URL ?? "").startsWith("file:");

const medicamentCreateSchema = z.object({
  nom: z.string().min(1, "Nom requis").max(300),
  principeActif: z.string().min(1, "Principe actif requis").max(300),
  dosage: z.string().min(1, "Dosage requis").max(120),
  numeroLot: z.string().max(120).optional().nullable(),
  quantite: z.coerce.number().int().min(0, "Quantité >= 0"),
  dateExpiration: z.coerce.date({ invalid_type_error: "Date invalide" }),
  codeBarre: z.string().max(120).optional().nullable(),
  equivalentNames: z.array(z.string().min(1).max(300)).optional().default([]),
});

function containsInsensitive(value) {
  if (supportsInsensitiveMode) return { contains: value, mode: "insensitive" };
  return { contains: value };
}

function equalsInsensitive(value) {
  if (supportsInsensitiveMode) return { equals: value, mode: "insensitive" };
  return { equals: value };
}

function mapMed(m, lot) {
  return {
    id: m.id,
    nom: m.nom,
    principeActif: m.principeActif,
    dosage: m.dosage,
    quantite: lot.quantite,
    dateExpiration: lot.dateExpiration,
    numeroLot: lot.numeroLot,
    lotId: lot.id,
  };
}

function summarizeMedicament(m) {
  const lots = (m.lots ?? []).filter((l) => l.quantite > 0);
  const quantite = lots.reduce((sum, l) => sum + l.quantite, 0);
  const prochainLot =
    lots.length > 0
      ? [...lots].sort(
          (a, b) =>
            new Date(a.dateExpiration).getTime() -
            new Date(b.dateExpiration).getTime()
        )[0]
      : null;
  return {
    id: m.id,
    nom: m.nom,
    principeActif: m.principeActif,
    dosage: m.dosage,
    codeBarre: m.codeBarre,
    quantite,
    dateExpiration: prochainLot?.dateExpiration ?? null,
    stockStatus: quantite < 5 ? "critical" : quantite < 10 ? "low" : "ok",
    lots: lots
      .sort(
        (a, b) =>
          new Date(a.dateExpiration).getTime() - new Date(b.dateExpiration).getTime()
      )
      .map((lot) => ({
        id: lot.id,
        numeroLot: lot.numeroLot,
        quantite: lot.quantite,
        dateExpiration: lot.dateExpiration,
      })),
  };
}

function normalizeText(input) {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function uniqCompact(values) {
  return [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];
}

function cleanText(input) {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function normalizeForMatch(input) {
  return cleanText(input)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%+/.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getCatalogBaseDirs() {
  const fromEnv = String(process.env.CATALOG_BASE_DIRS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
  return [...new Set([projectRootDir, serverRootDir, process.cwd(), ...fromEnv])];
}

function normalizeCode(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const digitsOnly = raw.replace(/\D+/g, "");
  if (digitsOnly.length >= 6) return digitsOnly;
  return raw.replace(/[^a-zA-Z0-9]+/g, "").toUpperCase();
}

function splitNameAndDosage(rawLine) {
  const line = cleanText(rawLine);
  if (!line) return { nom: "", dosage: "" };
  const dosageMatch = line.match(
    /\b\d+(?:[.,]\d+)?\s?(?:mg|g|mcg|µg|ml|ui|iu|mui|%)(?:\s*\/\s*\d+(?:[.,]\d+)?\s?(?:mg|g|mcg|µg|ml|ui|iu|mui|%))?/i
  );
  const dosage = cleanText(dosageMatch?.[0]);
  if (!dosage) return { nom: line, dosage: "" };
  const idx = line.toLowerCase().indexOf(dosage.toLowerCase());
  if (idx <= 0) return { nom: line, dosage };
  const nom = cleanText(line.slice(0, idx)).replace(/[-,;:\s]+$/g, "");
  return { nom, dosage };
}

function parseEquivalentCell(rawCell) {
  const raw = cleanText(rawCell);
  if (!raw) return [];
  return raw
    .split("|")
    .map((part) => cleanText(part))
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(.*?)\s*\[(\d{8,14})\]\s*$/);
      if (!match) {
        return { code: "", nom: part };
      }
      return {
        code: cleanText(match[2]),
        nom: cleanText(match[1]),
      };
    })
    .filter((row) => row.nom || row.code);
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
      "code_barres",
      "code ean 13",
    ])
  );
  const rawName = cleanText(
    readFieldFromRow(row, [
      "name",
      "nom",
      "nom commercial",
      "nom_commercial",
      "medicament",
      "nom medicament",
      "nom_medicament",
      "specialite",
      "libelle",
    ])
  );
  const dosage = cleanText(
    readFieldFromRow(row, [
      "dosage",
      "dosage1",
      "presentation",
      "forme",
      "unite_dosage",
      "unite dosage",
      "unit_dosage",
      "unite_dosage1",
      "unite dosage1",
    ])
  );
  const principle = cleanText(
    readFieldFromRow(row, ["composition", "composants", "principe actif", "principe_actif", "dci", "dci1"])
  );
  const equivalents = parseEquivalentCell(
    readFieldFromRow(row, ["equivalents", "equivalences", "equivalent", "équivalents"])
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
    nom: cleanText(parsed.nom || rawName || fullName),
    dosage: cleanText(parsed.dosage || dosage),
    principeActif: principle,
    equivalents,
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
    return rows.map((row) => parseMedicationRow(row)).filter(Boolean);
  } catch {
    return [];
  }
}

function getJsonSourceUrls() {
  const defaults = getCatalogBaseDirs().flatMap((baseDir) => [
    path.resolve(baseDir, "medications-cnops.json"),
    path.resolve(baseDir, "medications-cnss.json"),
    path.resolve(baseDir, "allmeds.json"),
  ]);
  const configured = String(process.env.CATALOG_JSON_PATHS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return [...new Set([...defaults, ...configured])];
}

function getXlsxSourceUrls() {
  const defaults = getCatalogBaseDirs().flatMap((baseDir) => [
    path.resolve(baseDir, "medicaments.xlsx"),
    path.resolve(baseDir, "ref-des-medicaments-cnops-2014 (1) (1).xlsx"),
    path.resolve(baseDir, "medicaments_organises.xlsx"),
  ]);
  const configured = String(process.env.CATALOG_XLSX_PATHS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return [...new Set([...defaults, ...configured])];
}

function getRmmgSourceUrls() {
  const configured = String(process.env.CATALOG_RMMG_PATHS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  return [...new Set(getCatalogBaseDirs().flatMap((baseDir) => [
    path.resolve(baseDir, "rmmg-ammps-2026.txt"),
    path.resolve(baseDir, "rmmg-ammps-2026.pdf.txt"),
  ]))];
}

async function getPdfSourceUrls() {
  const configured = String(process.env.CATALOG_PDF_PATHS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (configured.length > 0) return [...new Set(configured)];
  const out = [];
  for (const baseDir of getCatalogBaseDirs()) {
    try {
      const names = await readdir(baseDir);
      out.push(
        ...names
          .filter((name) => name.toLowerCase().endsWith(".pdf"))
          .map((name) => path.resolve(baseDir, name))
      );
    } catch {
      // ignore invalid dirs
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

async function readUnifiedCatalogSafe() {
  const mergedRows = [];
  const dataRows = await readDataTxtCatalogSafe(dataTxtPaths);
  if (dataRows.length > 0) {
    mergedRows.push(
      ...dataRows.map((row) => ({
        code: cleanText(row.code),
        nom: cleanText(row.nom || row.fullName),
        dosage: cleanText(row.dosage),
        principeActif: cleanText(row.principeActif),
        equivalents: Array.isArray(row.equivalents) ? row.equivalents : [],
        source: "data_txt",
      }))
    );
  }

  const xlsxBuffers = await Promise.all(
    getXlsxSourceUrls().map((filePath) => readArrayBufferFileSafe(filePath))
  );
  const xlsxRows = xlsxBuffers
    .flatMap((buf) => (buf ? parseXlsxMedications(buf) : []))
    .map((row) => ({
      code: cleanText(row.code),
      nom: cleanText(row.nom || row.fullName),
      dosage: cleanText(row.dosage),
      principeActif: cleanText(row.principeActif),
      equivalents: Array.isArray(row.equivalents) ? row.equivalents : [],
      source: "xlsx_local",
    }));
  if (xlsxRows.length > 0) mergedRows.push(...xlsxRows);

  const configured = String(process.env.CATALOG_UNIFIED_PATHS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const candidatePaths = [...new Set([...configured, ...unifiedCatalogPaths])];
  for (const filePath of candidatePaths) {
    const content = await readJsonFileSafe(filePath);
    if (!Array.isArray(content) || content.length === 0) continue;
    const rows = content
      .map((entry) => parseMedicationRow(entry))
      .filter(Boolean)
      .map((row) => ({
        code: cleanText(row.code),
        nom: cleanText(row.nom || row.fullName),
        dosage: cleanText(row.dosage),
        principeActif: cleanText(row.principeActif),
        equivalents: [],
        source: "catalog_local",
      }));
    if (rows.length > 0) mergedRows.push(...rows);
  }
  if (mergedRows.length === 0) return [];

  const dedup = new Map();
  for (const row of mergedRows) {
    const key = row.code
      ? `code:${normalizeCode(row.code)}`
      : buildSuggestionKey(row);
    if (!key) continue;
    if (!dedup.has(key)) {
      dedup.set(key, row);
      continue;
    }
    const existing = dedup.get(key);
    const existingScore = [existing.nom, existing.principeActif, existing.dosage]
      .map((x) => cleanText(x))
      .filter(Boolean).length;
    const candidateScore = [row.nom, row.principeActif, row.dosage]
      .map((x) => cleanText(x))
      .filter(Boolean).length;
    if (candidateScore > existingScore) {
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
    entries.push({ code, fullName: cleanText(core), nom, dosage, principeActif });
  };

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (
      (lower.startsWith("groupe therapeutique:") || lower.startsWith("groupe thérapeutique:")) &&
      line.includes(":")
    ) {
      currentGroup = cleanText(line.split(":").slice(1).join(":"));
      currentGroupPrinciple = "";
      currentGroupDosage = "";
      currentRowBuffer = "";
      continue;
    }
    if (lower.startsWith("dci:")) {
      currentGroupPrinciple = cleanText(line.split(":").slice(1).join(":"));
      continue;
    }
    if (lower.startsWith("dosage:")) {
      currentGroupDosage = cleanText(line.split(":").slice(1).join(":"));
      continue;
    }
    const hasBarcode = /\d{8,14}/.test(line);
    if (!currentGroup && !hasBarcode) continue;
    if (/^(bs|p|g|i)\s+/i.test(line)) {
      if (currentRowBuffer) flushRowIfComplete(currentRowBuffer);
      currentRowBuffer = line;
      if (codeRegex.test(currentRowBuffer)) {
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
    if (hasBarcode && currentGroup) flushRowIfComplete(line);
  }
  if (currentRowBuffer) flushRowIfComplete(currentRowBuffer);
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

async function loadReferenceSuggestionCatalog() {
  const now = Date.now();
  if (referenceSuggestCache.rows.length > 0 && referenceSuggestCache.expiresAt > now) {
    return referenceSuggestCache.rows;
  }

  const unifiedRows = await readUnifiedCatalogSafe();
  if (unifiedRows.length > 0) {
    referenceSuggestCache = {
      rows: unifiedRows,
      expiresAt: now + 12 * 60 * 60 * 1000,
    };
    return referenceSuggestCache.rows;
  }

  const jsonBatches = await Promise.all(getJsonSourceUrls().map((filePath) => readJsonFileSafe(filePath)));
  const jsonRows = jsonBatches
    .flatMap((batch) => (Array.isArray(batch) ? batch : []))
    .map((row) => parseMedicationRow(row))
    .filter(Boolean);

  const xlsxBuffers = await Promise.all(
    getXlsxSourceUrls().map((filePath) => readArrayBufferFileSafe(filePath))
  );
  const xlsxRows = xlsxBuffers.flatMap((buf) => (buf ? parseXlsxMedications(buf) : []));

  const rmmgTexts = await Promise.all(getRmmgSourceUrls().map((filePath) => readTextFileSafe(filePath)));
  const rmmgRows = rmmgTexts.flatMap((text) => parseRmmgText(text));

  const pdfTexts = await Promise.all((await getPdfSourceUrls()).map((filePath) => readPdfTextSafe(filePath)));
  const pdfRows = pdfTexts.flatMap((text) => [
    ...parseRmmgText(text),
    ...parseAnamGuideText(text),
  ]);

  const dedup = new Map();
  for (const row of [...jsonRows, ...xlsxRows, ...rmmgRows, ...pdfRows]) {
    const key = buildSuggestionKey(row);
    if (!key || dedup.has(key)) continue;
    dedup.set(key, {
      code: cleanText(row.code),
      nom: cleanText(row.nom || row.fullName),
      dosage: cleanText(row.dosage),
      principeActif: cleanText(row.principeActif),
      equivalents: Array.isArray(row.equivalents) ? row.equivalents : [],
      source: "catalog_local",
    });
  }

  referenceSuggestCache = {
    rows: [...dedup.values()],
    expiresAt: now + 12 * 60 * 60 * 1000,
  };
  return referenceSuggestCache.rows;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[a.length][b.length];
}

function fuzzyScore(query, med) {
  const nq = normalizeText(query);
  if (!nq) return 0;
  const fields = [med.nom, med.principeActif, med.dosage]
    .map(normalizeText)
    .filter(Boolean);
  let best = 0;
  for (const field of fields) {
    if (field.includes(nq)) {
      best = Math.max(best, Math.min(1, nq.length / field.length + 0.45));
      continue;
    }
    const distance = levenshtein(nq, field.slice(0, Math.max(nq.length, 1)));
    const score = 1 - distance / Math.max(nq.length, field.length, 1);
    best = Math.max(best, score);
  }
  return best;
}

function scoreCatalogMatch(query, row) {
  const nq = normalizeForMatch(query);
  if (!nq) return 0;
  const name = normalizeForMatch(row?.nom);
  const pa = normalizeForMatch(row?.principeActif);
  const dosage = normalizeForMatch(row?.dosage);
  let score = 0;
  if (name.startsWith(nq)) score += 120;
  if (name.includes(nq)) score += 80;
  if (pa.includes(nq)) score += 60;
  if (dosage.includes(nq)) score += 30;
  const nameTokenMax = Math.max(
    0,
    ...name
      .split(" ")
      .filter(Boolean)
      .map((token) => {
        const prefix = token.slice(0, Math.max(nq.length, 1));
        return 1 - levenshtein(nq, prefix) / Math.max(prefix.length, nq.length, 1);
      })
  );
  const paTokenMax = Math.max(
    0,
    ...pa
      .split(" ")
      .filter(Boolean)
      .map((token) => {
        const prefix = token.slice(0, Math.max(nq.length, 1));
        return 1 - levenshtein(nq, prefix) / Math.max(prefix.length, nq.length, 1);
      })
  );
  score += Math.max(nameTokenMax, paTokenMax) * 50;
  return score;
}

function buildSuggestionKey(item) {
  const code = cleanText(item?.code || item?.codeBarre);
  const normalizedCode = normalizeCode(code);
  if (normalizedCode) return `code:${normalizedCode}`;
  return `${normalizeText(item.nom)}|${normalizeText(item.dosage)}|${normalizeText(item.principeActif)}`;
}

function buildQueryCandidates(query) {
  const original = String(query ?? "").trim();
  const normalized = normalizeText(original);
  return uniqCompact([original, normalized]);
}

async function ensureEquivalentReference(principeActif, nomMedicament) {
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

async function fetchLocalAndReferenceSuggestions(query) {
  const candidates = uniqCompact([query, ...buildQueryCandidates(query)]).slice(0, 8);
  const localRows = await prisma.medicament.findMany({
    where: {
      OR: candidates.flatMap((candidate) => [
        { nom: containsInsensitive(candidate) },
        { principeActif: containsInsensitive(candidate) },
      ]),
    },
    orderBy: { nom: "asc" },
    take: 40,
  });
  const localSuggestions = localRows.map((m) => ({
    code: cleanText(m.codeBarre),
    nom: m.nom,
    dosage: m.dosage,
    principeActif: m.principeActif,
    equivalents: [],
    source: "local",
  }));
  const nq = normalizeForMatch(query);
  const referenceCatalog = await loadReferenceSuggestionCatalog();
  const referenceSuggestions = referenceCatalog
    .map((item) => {
      const name = normalizeForMatch(item.nom);
      const pa = normalizeForMatch(item.principeActif);
      if (!name && !pa) return { item, score: 0 };
      let score = 0;
      if (name.startsWith(nq)) score += 120;
      if (name.includes(nq)) score += 70;
      if (pa.includes(nq)) score += 55;
      const nameTokenMax = Math.max(
        0,
        ...name
          .split(" ")
          .filter(Boolean)
          .map((token) => {
            const prefix = token.slice(0, Math.max(nq.length, 1));
            return 1 - levenshtein(nq, prefix) / Math.max(prefix.length, nq.length, 1);
          })
      );
      const paTokenMax = Math.max(
        0,
        ...pa
          .split(" ")
          .filter(Boolean)
          .map((token) => {
            const prefix = token.slice(0, Math.max(nq.length, 1));
            return 1 - levenshtein(nq, prefix) / Math.max(prefix.length, nq.length, 1);
          })
      );
      score += Math.max(nameTokenMax, paTokenMax) * 60;
      if (nq.length >= 4 && Math.max(nameTokenMax, paTokenMax) >= 0.55) score += 20;
      return { item, score };
    })
    .filter((entry) => entry.score >= 25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 120)
    .map((entry) => entry.item);

  return { localSuggestions, referenceSuggestions };
}

export async function suggestMedicaments(req, res) {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) {
    return res.json({ query: q, items: [] });
  }

  const { localSuggestions, referenceSuggestions } =
    await fetchLocalAndReferenceSuggestions(q);
  const merged = [
    ...localSuggestions,
    ...referenceSuggestions,
  ];
  const seen = new Set();
  const items = [];

  for (const row of merged) {
    const key = buildSuggestionKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(row);
    if (items.length >= 30) break;
  }

  return res.json({ query: q, items });
}

export async function autocompleteMedicaments(req, res) {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) return res.json([]);
  const { items } = await (async () => {
    const { localSuggestions, referenceSuggestions } =
      await fetchLocalAndReferenceSuggestions(q);
    const merged = [...localSuggestions, ...referenceSuggestions];
    const seen = new Set();
    const deduped = [];
    for (const row of merged) {
      const key = buildSuggestionKey(row);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(row);
      if (deduped.length >= 10) break;
    }
    return { items: deduped };
  })();
  return res.json(items.map((item) => item.nom));
}

export async function searchMedicaments(req, res) {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    return res.status(400).json({ error: "Paramètre q requis" });
  }

  const pattern = containsInsensitive(q);
  const exactPattern = equalsInsensitive(q);

  const directMatches = await prisma.medicament.findMany({
    where: {
      OR: [{ nom: exactPattern }, { nom: pattern }, { principeActif: pattern }],
    },
    include: { lots: true },
  });

  const directAvailableLots = directMatches
    .flatMap((m) =>
      m.lots
        .filter((l) => l.quantite > 0)
        .map((lot) => ({ medicament: m, lot }))
    )
    .sort(
      (a, b) =>
        new Date(a.lot.dateExpiration).getTime() -
        new Date(b.lot.dateExpiration).getTime()
    );

  if (directAvailableLots.length > 0) {
    const recommended = directAvailableLots[0];
    return res.json({
      status: "disponible",
      message: null,
      recommended: mapMed(recommended.medicament, recommended.lot),
      items: directAvailableLots.map(({ medicament, lot }) =>
        mapMed(medicament, lot)
      ),
      requestedQuery: q,
    });
  }

  const principles = new Set(
    directMatches.map((m) => m.principeActif.trim()).filter(Boolean)
  );

  // Fallback approximation: used only to infer active principle,
  // never to mark query as directly "disponible".
  if (principles.size === 0) {
    const all = await prisma.medicament.findMany({ include: { lots: true } });
    const fuzzyMatches = all
      .map((m) => ({ med: m, score: fuzzyScore(q, m) }))
      .filter((entry) => entry.score >= 0.86)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.med)
      .slice(0, 3);
    for (const m of fuzzyMatches) {
      if (m?.principeActif?.trim()) principles.add(m.principeActif.trim());
    }
  }

  const paList = [...principles];

  let altMeds = [];
  if (paList.length > 0) {
    altMeds = await prisma.medicament.findMany({
      where: {
        OR: paList.map((pa) => ({
          principeActif: equalsInsensitive(pa),
        })),
      },
      include: { lots: true },
    });
  }

  const equivalents = altMeds
    .map((m) => summarizeMedicament(m))
    .filter((m) => m.id !== directMatches?.[0]?.id);

  const referenceCatalog = await loadReferenceSuggestionCatalog();
  const referenceQueryRows = referenceCatalog
    .map((row) => ({ row, score: scoreCatalogMatch(q, row) }))
    .filter((entry) => entry.score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((entry) => entry.row);
  const referenceEquivalentRows = referenceCatalog
    .filter((row) => {
      const pa = normalizeText(row.principeActif);
      if (!pa) return false;
      return paList.some((candidatePa) => normalizeText(candidatePa) === pa);
    })
    .filter((row) => normalizeText(row.nom) !== normalizeText(q))
    .slice(0, 20);
  const referencePool = [...referenceEquivalentRows, ...referenceQueryRows];
  const referenceDedup = new Map();
  for (const row of referencePool) {
    const key = buildSuggestionKey(row);
    if (!key || referenceDedup.has(key)) continue;
    referenceDedup.set(key, row);
  }

  const normalizedLocalEqKeys = new Set(
    equivalents.map(
      (m) =>
        `${normalizeText(m.nom)}|${normalizeText(m.principeActif)}|${normalizeText(m.dosage)}`
    )
  );
  const catalogEquivalents = [...referenceDedup.values()]
    .map((row) => ({
      id: null,
      nom: cleanText(row.nom),
      principeActif: cleanText(row.principeActif),
      dosage: cleanText(row.dosage),
      codeBarre: cleanText(row.code),
      quantite: 0,
      dateExpiration: null,
      stockStatus: "catalog",
      lots: [],
      source: cleanText(row.source || "data_txt"),
    }))
    .filter((row) => row.nom)
    .filter(
      (row) =>
        !normalizedLocalEqKeys.has(
          `${normalizeText(row.nom)}|${normalizeText(row.principeActif)}|${normalizeText(
            row.dosage
          )}`
        )
    );
  const allEquivalents = [...equivalents, ...catalogEquivalents];

  const equivalentAvailableLots = altMeds
    .flatMap((m) =>
      (m.lots ?? [])
        .filter((lot) => lot.quantite > 0)
        .map((lot) => ({ medicament: m, lot }))
    )
    .sort(
      (a, b) =>
        new Date(a.lot.dateExpiration).getTime() -
        new Date(b.lot.dateExpiration).getTime()
    );

  if (equivalentAvailableLots.length > 0) {
    const recommended = equivalentAvailableLots[0];
    return res.json({
      status: "equivalent_disponible",
      message: `Médicament demandé indisponible. Équivalent disponible en stock: ${recommended.medicament.nom}.`,
      recommended: mapMed(recommended.medicament, recommended.lot),
      items: equivalentAvailableLots.map(({ medicament, lot }) =>
        mapMed(medicament, lot)
      ),
      equivalents: allEquivalents,
      requestedQuery: q,
    });
  }

  return res.json({
    status: "non_disponible",
    message: "Médicament non disponible",
    recommended: null,
    items: [],
    equivalents: allEquivalents,
    requestedQuery: q,
  });
}

router.get("/search", searchMedicaments);
router.get("/suggest", suggestMedicaments);
router.get("/autocomplete", autocompleteMedicaments);

router.post("/", async (req, res) => {
  const parsed = medicamentCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const {
    nom,
    principeActif,
    dosage,
    numeroLot,
    quantite,
    dateExpiration,
    codeBarre,
    equivalentNames,
  } = parsed.data;
  const lotValue =
    numeroLot?.trim() ||
    `AUTO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()}`;

  const result = await prisma.$transaction(async (tx) => {
    const med = await tx.medicament.upsert({
      where: {
        nom_principeActif_dosage: {
          nom,
          principeActif,
          dosage,
        },
      },
      update: {
        codeBarre: codeBarre?.trim() || null,
      },
      create: {
        nom,
        principeActif,
        dosage,
        codeBarre: codeBarre?.trim() || null,
      },
    });

    await tx.lot.upsert({
      where: {
        medicamentId_numeroLot_dateExpiration: {
          medicamentId: med.id,
          numeroLot: lotValue,
          dateExpiration,
        },
      },
      update: {
        quantite: { increment: quantite },
      },
      create: {
        medicamentId: med.id,
        numeroLot: lotValue,
        quantite,
        dateExpiration,
      },
    });

    return tx.medicament.findUnique({
      where: { id: med.id },
      include: { lots: true },
    });
  });

  // Keep "equivalent" references synced automatically after each add.
  const samePrincipleMeds = await prisma.medicament.findMany({
    where: { principeActif: equalsInsensitive(principeActif) },
    select: { nom: true },
    take: 200,
  });
  const suggestedNames = [...new Set((equivalentNames ?? []).map((x) => cleanText(x)).filter(Boolean))];
  const allEquivalentNames = [
    ...samePrincipleMeds.map((m) => cleanText(m.nom)),
    ...suggestedNames,
  ];
  for (const equivalentName of allEquivalentNames) {
    // eslint-disable-next-line no-await-in-loop
    await ensureEquivalentReference(principeActif, equivalentName);
  }

  res.status(201).json(summarizeMedicament(result));
});

router.get("/", async (req, res) => {
  const list = await prisma.medicament.findMany({
    include: { lots: true },
    orderBy: { nom: "asc" },
  });
  const mapped = list
    .map(summarizeMedicament)
    .sort(
      (a, b) =>
        new Date(a.dateExpiration ?? "9999-12-31").getTime() -
        new Date(b.dateExpiration ?? "9999-12-31").getTime()
    );
  res.json(mapped);
});

router.put("/:id/use", async (req, res) => {
  const id = req.params.id;
  const schema = z.object({
    quantite: z.coerce.number().int().min(1).optional().default(1),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { quantite } = parsed.data;

  const userId = req.user?.sub;
  if (!userId) {
    return res.status(401).json({ error: "Utilisateur non identifié" });
  }

  const med = await prisma.medicament.findUnique({
    where: { id },
    include: { lots: true },
  });
  if (!med) return res.status(404).json({ error: "Médicament introuvable" });

  const orderedLots = (med.lots ?? [])
    .filter((l) => l.quantite > 0)
    .sort(
      (a, b) =>
        new Date(a.dateExpiration).getTime() - new Date(b.dateExpiration).getTime()
    );
  const stockTotal = orderedLots.reduce((sum, l) => sum + l.quantite, 0);
  if (stockTotal < quantite) {
    return res.status(400).json({ error: "Stock insuffisant" });
  }

  let remaining = quantite;
  await prisma.$transaction(async (tx) => {
    for (const lot of orderedLots) {
      if (remaining <= 0) break;
      const take = Math.min(lot.quantite, remaining);
      await tx.lot.update({
        where: { id: lot.id },
        data: { quantite: lot.quantite - take },
      });
      await tx.dispenseHistory.create({
        data: {
          medicamentId: med.id,
          lotId: lot.id,
          userId,
          quantite: take,
        },
      });
      remaining -= take;
    }
  });

  const updated = await prisma.medicament.findUnique({
    where: { id },
    include: { lots: true },
  });
  res.json(summarizeMedicament(updated));
});

router.delete("/:id", async (req, res) => {
  const id = req.params.id;
  const med = await prisma.medicament.findUnique({
    where: { id },
    include: { lots: true },
  });
  if (!med) return res.status(404).json({ error: "Médicament introuvable" });

  const stockTotal = (med.lots ?? []).reduce((sum, lot) => sum + lot.quantite, 0);
  await prisma.medicament.delete({ where: { id } });

  res.json({
    ok: true,
    deleted: {
      id: med.id,
      nom: med.nom,
      principeActif: med.principeActif,
      dosage: med.dosage,
      stockTotal,
    },
  });
});

export default router;
