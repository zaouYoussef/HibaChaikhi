import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

const router = Router();

const medicamentCreateSchema = z.object({
  nom: z.string().min(1, "Nom requis").max(300),
  principeActif: z.string().min(1, "Principe actif requis").max(300),
  dosage: z.string().min(1, "Dosage requis").max(120),
  numeroLot: z.string().max(120).optional().nullable(),
  quantite: z.coerce.number().int().min(0, "Quantité >= 0"),
  dateExpiration: z.coerce.date({ invalid_type_error: "Date invalide" }),
  codeBarre: z.string().max(120).optional().nullable(),
});

function containsInsensitive(value) {
  return { contains: value, mode: "insensitive" };
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

function buildSuggestionKey(item) {
  return `${normalizeText(item.nom)}|${normalizeText(item.dosage)}|${normalizeText(item.principeActif)}`;
}

function buildQueryCandidates(query) {
  const original = String(query ?? "").trim();
  const normalized = normalizeText(original);
  return uniqCompact([original, normalized]);
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
    take: 20,
  });
  const localSuggestions = localRows.map((m) => ({
    nom: m.nom,
    dosage: m.dosage,
    principeActif: m.principeActif,
    source: "local",
  }));

  return { localSuggestions, referenceSuggestions: [] };
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
    if (items.length >= 10) break;
  }

  return res.json({ query: q, items });
}

export async function autocompleteMedicaments(req, res) {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) return res.json([]);
  const { items } = await (async () => {
    const { localSuggestions } = await fetchLocalAndReferenceSuggestions(q);
    const merged = [...localSuggestions];
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
  const exactPattern = { equals: q, mode: "insensitive" };

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
          principeActif: { equals: pa, mode: "insensitive" },
        })),
      },
      include: { lots: true },
    });
  }

  const equivalents = altMeds
    .map((m) => summarizeMedicament(m))
    .filter((m) => m.id !== directMatches?.[0]?.id);

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
      equivalents,
      requestedQuery: q,
    });
  }

  return res.json({
    status: "non_disponible",
    message: "Médicament non disponible",
    recommended: null,
    items: [],
    equivalents,
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
