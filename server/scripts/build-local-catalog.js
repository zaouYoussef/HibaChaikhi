import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { PDFParse } from "pdf-parse";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRootDir = path.resolve(__dirname, "..", "..");
const serverRootDir = path.resolve(__dirname, "..");

function cleanText(input) {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(input) {
  return cleanText(input)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
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

function getCatalogBaseDirs() {
  const fromEnv = String(process.env.CATALOG_BASE_DIRS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
  return [...new Set([projectRootDir, serverRootDir, process.cwd(), ...fromEnv])];
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
      // ignore
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
    if (/^code ean/i.test(normalizeForMatch(line))) {
      flushCurrent();
      current = null;
      continue;
    }
    current.parts.push(line);
  }
  flushCurrent();
  return entries;
}

function scoreRowQuality(row) {
  const nameLen = cleanText(row?.nom).length;
  const principleLen = cleanText(row?.principeActif).length;
  const dosageLen = cleanText(row?.dosage).length;
  return (
    (principleLen > 1 ? 30 : 0) +
    (dosageLen > 1 ? 15 : 0) +
    (nameLen > 0 ? Math.max(1, 20 - Math.floor(nameLen / 8)) : 0)
  );
}

function pickBetterRow(currentRow, candidateRow) {
  if (!currentRow) return candidateRow;
  if (!candidateRow) return currentRow;
  return scoreRowQuality(candidateRow) > scoreRowQuality(currentRow)
    ? candidateRow
    : currentRow;
}

async function buildRows() {
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
    const normalizedCode = normalizeCode(row.code);
    const key = normalizedCode
      ? `code:${normalizedCode}`
      : `${normalizeText(row.nom)}|${normalizeText(row.dosage)}|${normalizeText(
          row.principeActif
        )}`;
    if (!key) continue;
    const normalizedRow = {
      code: normalizeCode(row.code),
      nom: cleanText(row.nom || row.fullName),
      dosage: cleanText(row.dosage),
      principeActif: cleanText(row.principeActif),
      fullName: cleanText(row.fullName || row.nom),
    };
    if (!dedup.has(key)) {
      dedup.set(key, normalizedRow);
      continue;
    }
    dedup.set(key, pickBetterRow(dedup.get(key), normalizedRow));
  }
  return [...dedup.values()];
}

async function main() {
  const startedAt = Date.now();
  const rows = await buildRows();
  const outPath = path.resolve(projectRootDir, "catalog-local-unified.json");
  await writeFile(outPath, JSON.stringify(rows), "utf-8");
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Unified catalog generated: ${rows.length} rows in ${seconds}s`);
  console.log(`Output: ${outPath}`);
}

main().catch((err) => {
  console.error("Failed to build unified catalog:", err);
  process.exit(1);
});
