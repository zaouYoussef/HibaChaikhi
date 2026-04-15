const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_PATH = path.join(ROOT, "data.txt");
const EMV_PATH = path.join(ROOT, "emv.txt");
const UNIFIED_PATH = path.join(ROOT, "catalog-local-unified.json");

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function normalizeCode(value) {
  const digits = String(value ?? "").replace(/\D+/g, "");
  if (digits.length === 13) return digits;
  return "";
}

function buildDosageFromParts(dosage, unit) {
  const d = cleanText(dosage);
  const u = cleanText(unit);
  if (!d && !u) return "";
  if (!u) return d;
  if (!d) return u;
  if (d.toUpperCase().includes(u.toUpperCase())) return d;
  return `${d} ${u}`;
}

function scoreRow(row) {
  let score = 0;
  if (row.codeBarres) score += 10;
  if (row.nomCommercial) score += 8;
  if (row.principeActif) score += 6;
  if (row.dosage) score += 4;
  return score;
}

function rowQuality(row) {
  return (
    scoreRow(row) +
    (looksLikePresentationNoise(row.principeActif) ? -3 : 2) +
    (row.nomCommercial.length >= 3 ? 1 : 0)
  );
}

function parseTabular(content) {
  const lines = String(content || "")
    .split(/\r?\n/g)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split("\t").map((h) => cleanText(h));
  if (headers.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split("\t");
    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = cleanText(cells[j] ?? "");
    }
    out.push(row);
  }
  return out;
}

function parseFlexibleLine(line) {
  const clean = cleanText(line);
  const m = clean.match(/^(\d{13})\s+(.+)$/);
  if (!m) return null;
  const code = m[1];
  const rest = cleanText(m[2]);
  const dosageMatch = rest.match(
    /\b\d+(?:[.,]\d+)?\s?(?:MG|G|MCG|UG|µG|ML|UI|IU|MUI|%)\b(?:\s*\/\s*\d+(?:[.,]\d+)?\s?(?:MG|G|MCG|UG|µG|ML|UI|IU|MUI|%))?/i
  );
  if (!dosageMatch) {
    return {
      codeBarres: code,
      nomCommercial: rest,
      principeActif: "",
      dosage: "",
    };
  }
  const dosage = cleanText(dosageMatch[0]);
  const idx = rest.toUpperCase().indexOf(dosage.toUpperCase());
  const name = idx > 0 ? cleanText(rest.slice(0, idx)) : rest;
  const tail = idx >= 0 ? cleanText(rest.slice(idx + dosage.length)) : "";
  const formeMarkers =
    /(POUDRE|SOLUTION|SIROP|GELULE|COMPRIME|POMMADE|CREME|COLLYRE|SUSPENSION|OVULE|INJECTABLE|PERFUSION|PASTILLE|PATCH|AEROSOL|PULVERISATION|EMULSION|GRANULE)/i;
  const pa = formeMarkers.test(tail)
    ? cleanText(tail.split(formeMarkers)[0])
    : cleanText(tail);
  return {
    codeBarres: code,
    nomCommercial: name || rest,
    principeActif: pa,
    dosage,
  };
}

function normalizeFromRow(row) {
  const codeBarres = normalizeCode(
    row.CODE_BARRES || row.CODE || row["CODE EAN 13"] || row.code || row.id
  );
  if (!codeBarres) return null;
  const nomCommercial = cleanText(
    row.NOM_COMMERCIAL ||
      row.NOM ||
      row.name ||
      row.nom ||
      row["Nom de la spécialité ou nom commercial du médicament"]
  );
  const principeActif = cleanText(
    row.PRINCIPE_ACTIF ||
      row.DCI1 ||
      row.DCI ||
      row.dci ||
      row["Dénomination Commune Internationale"] ||
      row.principeActif ||
      row.COMPOSITION ||
      row.COMPOSANTS
  );
  const dosage = cleanText(
    row.DOSAGE ||
      row.dosage ||
      buildDosageFromParts(
        row.DOSAGE1 || row.dosage1,
        row.UNITE_DOSAGE1 || row.UNITE_DOSAGE
      )
  );

  const looksLikeHeader =
    normalizeText(nomCommercial) === "NOM" ||
    normalizeText(principeActif) === "COMPOSANTS";
  if (looksLikeHeader) return null;

  return { codeBarres, nomCommercial, principeActif, dosage };
}

function loadUnifiedIndex() {
  if (!fs.existsSync(UNIFIED_PATH)) return new Map();
  try {
    const rows = JSON.parse(fs.readFileSync(UNIFIED_PATH, "utf8"));
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const code = normalizeCode(row?.code);
      if (!code) continue;
      map.set(code, {
        nomCommercial: cleanText(row?.nom || row?.fullName),
        principeActif: cleanText(row?.principeActif),
        dosage: cleanText(row?.dosage),
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

function looksLikePresentationNoise(value) {
  const v = normalizeText(value);
  if (!v) return true;
  if (
    v.includes("BOITE") ||
    v.includes("FLACON") ||
    v.includes("SACHET") ||
    v.includes("SERINGUE") ||
    v.includes("POCHE") ||
    v.includes("TUBE") ||
    v.includes("OUI")
  ) {
    return true;
  }
  const digitCount = (v.match(/\d/g) || []).length;
  return digitCount > Math.max(6, Math.floor(v.length / 3));
}

function main() {
  const allCandidates = [];
  const sourceStats = [];

  for (const sourcePath of [EMV_PATH, DATA_PATH]) {
    if (!fs.existsSync(sourcePath)) continue;
    const raw = fs.readFileSync(sourcePath, "utf8");
    const tabRows = parseTabular(raw).map((row) => normalizeFromRow(row)).filter(Boolean);
    const freeRows = raw
      .split(/\r?\n/g)
      .map((line) => parseFlexibleLine(line))
      .filter(Boolean);
    allCandidates.push(...tabRows, ...freeRows);
    sourceStats.push({
      file: path.basename(sourcePath),
      tabRows: tabRows.length,
      freeRows: freeRows.length,
    });
  }

  const unifiedByCode = loadUnifiedIndex();
  const byCode = new Map();
  for (const row of allCandidates) {
    const key = row.codeBarres;
    const current = byCode.get(key);
    if (!current || rowQuality(row) > rowQuality(current)) {
      byCode.set(key, row);
      continue;
    }
    if (
      !current.nomCommercial &&
      (row.nomCommercial || row.principeActif || row.dosage)
    ) {
      byCode.set(key, row);
    }
  }

  // Enrich missing fields from unified catalog without dropping any barcode.
  for (const [code, row] of byCode.entries()) {
    const extra = unifiedByCode.get(code);
    if (!extra) continue;
    byCode.set(code, {
      codeBarres: code,
      nomCommercial: row.nomCommercial || extra.nomCommercial || "",
      principeActif:
        !row.principeActif || looksLikePresentationNoise(row.principeActif)
          ? extra.principeActif || row.principeActif || ""
          : row.principeActif,
      dosage: row.dosage || extra.dosage || "",
    });
  }

  const uniqueRows = [...byCode.values()];
  const groupByActifDosage = new Map();
  const groupByActifOnly = new Map();
  for (const row of uniqueRows) {
    const actifKey = normalizeText(row.principeActif);
    const dosageKey = normalizeText(row.dosage);
    if (!actifKey) continue;
    if (!groupByActifOnly.has(actifKey)) groupByActifOnly.set(actifKey, []);
    groupByActifOnly.get(actifKey).push(row);
    if (dosageKey) {
      const strictKey = `${actifKey}__${dosageKey}`;
      if (!groupByActifDosage.has(strictKey)) groupByActifDosage.set(strictKey, []);
      groupByActifDosage.get(strictKey).push(row);
    }
  }

  const outputRows = uniqueRows
    .map((row) => {
      const actifKey = normalizeText(row.principeActif);
      const dosageKey = normalizeText(row.dosage);
      const strictKey = actifKey && dosageKey ? `${actifKey}__${dosageKey}` : "";
      const strictMatches = strictKey ? groupByActifDosage.get(strictKey) || [] : [];
      const relaxedMatches = actifKey ? groupByActifOnly.get(actifKey) || [] : [];
      const pool = strictMatches.length > 1 ? strictMatches : relaxedMatches;
      const equivalents = [...new Set(
        pool
          .filter((candidate) => candidate.codeBarres !== row.codeBarres)
          .map((candidate) => `${candidate.nomCommercial} [${candidate.codeBarres}]`)
          .filter(Boolean)
      )]
        .sort((a, b) => a.localeCompare(b, "fr"))
        .join(" | ");
      return {
        CODE_BARRES: row.codeBarres,
        NOM_COMMERCIAL: row.nomCommercial,
        PRINCIPE_ACTIF: row.principeActif,
        DOSAGE: row.dosage,
        EQUIVALENTS: equivalents,
      };
    })
    .sort((a, b) => a.CODE_BARRES.localeCompare(b.CODE_BARRES));

  const header =
    "CODE_BARRES\tNOM_COMMERCIAL\tPRINCIPE_ACTIF\tDOSAGE\tEQUIVALENTS";
  const body = outputRows
    .map((row) =>
      [
        row.CODE_BARRES,
        row.NOM_COMMERCIAL,
        row.PRINCIPE_ACTIF,
        row.DOSAGE,
        row.EQUIVALENTS,
      ]
        .map((v) => cleanText(v))
        .join("\t")
    )
    .join("\n");
  fs.writeFileSync(DATA_PATH, `${header}\n${body}\n`, "utf8");

  console.log("Sources:", sourceStats);
  console.log(
    `data.txt reconstruit: ${allCandidates.length} lignes candidates -> ${outputRows.length} codes-barres uniques`
  );
}

main();
