import { readFile } from "node:fs/promises";
import path from "node:path";

function cleanText(input) {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function normalizeForMatch(input) {
  return cleanText(input)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeCode(input) {
  const digits = String(input ?? "").replace(/\D+/g, "");
  if (digits.length < 8) return "";
  if (digits.length <= 14) return digits;
  return digits.slice(0, 13);
}

function scoreRowQuality(row) {
  let score = 0;
  if (row?.code) score += 10;
  if (row?.nom) score += 8;
  if (row?.principeActif) score += 6;
  if (row?.dosage) score += 4;
  return score;
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
        return {
          code: "",
          nom: part,
        };
      }
      return {
        code: normalizeCode(match[2]),
        nom: cleanText(match[1]),
      };
    })
    .filter((eq) => eq.nom || eq.code);
}

function indexOfHeader(headers, aliases) {
  const targets = aliases.map((alias) => normalizeForMatch(alias));
  return headers.findIndex((header) => targets.includes(normalizeForMatch(header)));
}

function parseDataTxt(raw) {
  const lines = String(raw ?? "")
    .split(/\r?\n/g)
    .map((line) => line.replace(/\uFEFF/g, ""))
    .filter((line) => cleanText(line));
  if (lines.length === 0) return [];

  const headers = lines[0].split("\t").map((h) => cleanText(h));
  const codeIdx = indexOfHeader(headers, [
    "CODE_BARRES",
    "CODE",
    "EAN",
    "EAN13",
    "CODE_EAN_13",
  ]);
  const nomIdx = indexOfHeader(headers, ["NOM_COMMERCIAL", "NOM", "NAME"]);
  const paIdx = indexOfHeader(headers, [
    "PRINCIPE_ACTIF",
    "DCI",
    "DCI1",
    "COMPOSITION",
    "COMPOSANTS",
  ]);
  const dosageIdx = indexOfHeader(headers, ["DOSAGE", "DOSAGE1"]);
  const eqIdx = indexOfHeader(headers, ["EQUIVALENTS", "EQUIVALENCES", "EQUIVALENT"]);

  if (codeIdx === -1 || nomIdx === -1) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split("\t");
    const code = normalizeCode(cells[codeIdx]);
    const nom = cleanText(cells[nomIdx]);
    const principeActif = paIdx >= 0 ? cleanText(cells[paIdx]) : "";
    const dosage = dosageIdx >= 0 ? cleanText(cells[dosageIdx]) : "";
    const equivalents = eqIdx >= 0 ? parseEquivalentCell(cells[eqIdx]) : [];

    if (!code || !nom) continue;
    rows.push({
      code,
      nom,
      fullName: nom,
      dosage,
      principeActif,
      equivalents,
    });
  }
  return rows;
}

export function getDataTxtSourcePaths(baseDirs, configured = "") {
  const configuredPaths = String(configured ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
  const defaults = (baseDirs ?? []).map((baseDir) => path.resolve(baseDir, "data.txt"));
  return [...new Set([...configuredPaths, ...defaults])];
}

export async function readDataTxtCatalogSafe(candidatePaths) {
  for (const filePath of candidatePaths ?? []) {
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parseDataTxt(raw);
      if (parsed.length === 0) continue;

      const dedup = new Map();
      for (const row of parsed) {
        const key = row.code;
        const existing = dedup.get(key);
        if (!existing || scoreRowQuality(row) > scoreRowQuality(existing)) {
          dedup.set(key, row);
        }
      }
      return [...dedup.values()];
    } catch {
      // ignore unreadable path
    }
  }
  return [];
}
