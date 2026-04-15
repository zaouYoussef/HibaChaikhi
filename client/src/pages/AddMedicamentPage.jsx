import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api.js";
import BarcodeScanner from "../components/BarcodeScanner.jsx";

const empty = {
  nom: "",
  principeActif: "",
  dosage: "",
  numeroLot: "",
  quantite: "",
  dateExpiration: "",
};

/** Déduplique les fiches déjà en stock (même nom + principe actif + dosage). */
function uniqueTemplates(meds) {
  const map = new Map();
  for (const m of meds) {
    const key = `${String(m.nom).trim().toLowerCase()}|${String(m.principeActif).trim().toLowerCase()}|${String(m.dosage).trim().toLowerCase()}`;
    if (!map.has(key)) map.set(key, m);
  }
  return [...map.values()];
}

function isBarcodeLike(value) {
  const cleaned = String(value ?? "").replace(/\s+/g, "");
  return /^\d{6,}$/.test(cleaned);
}

function extractDosageFromText(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const dosageRegex =
    /\b\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|ug|ml|ui|iu|mui|%)(?:\s*\/\s*\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|ug|ml|ui|iu|mui|%))*\b/i;
  const match = text.match(dosageRegex);
  return match?.[0]?.trim() || "";
}

function splitCommercialNameAndDosage(rawName, rawDosage) {
  const sourceName = String(rawName ?? "").trim();
  const sourceDosage = String(rawDosage ?? "").trim();

  if (!sourceName) {
    return { nom: "", dosage: sourceDosage };
  }

  const dosage = sourceDosage || extractDosageFromText(sourceName);
  let nom = sourceName;

  if (dosage) {
    const idx = sourceName.toLowerCase().indexOf(dosage.toLowerCase());
    if (idx > 0) {
      nom = sourceName.slice(0, idx).trim();
    }
  } else if (sourceName.includes(",")) {
    nom = sourceName.split(",")[0].trim();
  }

  nom = nom.replace(/[-,;:\s]+$/g, "").trim();
  return { nom, dosage };
}

function extractBestBarcodeCandidate(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const compact = text.replace(/\s+/g, "");
  const exact = compact.match(/^\d{8,14}$/)?.[0];
  if (exact) return exact;
  const candidates = [...text.matchAll(/\d{8,14}/g)].map((m) => m[0]);
  if (candidates.length === 0) return compact;
  const ean13 = candidates.find((c) => c.length === 13);
  return ean13 || candidates.sort((a, b) => b.length - a.length)[0];
}

export default function AddMedicamentPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState(empty);
  const [scanOpen, setScanOpen] = useState(false);
  const [msg, setMsg] = useState({ type: "", text: "" });
  const [loading, setLoading] = useState(false);
  const [catalog, setCatalog] = useState([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [remoteSuggestions, setRemoteSuggestions] = useState([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const nomInputRef = useRef(null);
  const suggestRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/medicaments")
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setCatalog(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    window.history.pushState({ __inAppBackGuard: true }, "", window.location.href);
    const onPopState = () => {
      navigate("/", { replace: true });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navigate]);

  const localSuggestions = useMemo(() => {
    const q = form.nom.trim().toLowerCase();
    if (q.length < 2) return [];
    const templates = uniqueTemplates(catalog);
    return templates
      .filter(
        (m) =>
          m.nom.toLowerCase().includes(q) ||
          m.principeActif.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [form.nom, catalog]);

  useEffect(() => {
    const q = form.nom.trim();
    if (q.length < 2) {
      setRemoteSuggestions([]);
      setSuggestLoading(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSuggestLoading(true);
      try {
        const data = await apiFetch(`/suggest?q=${encodeURIComponent(q)}`);
        if (!cancelled) {
          const list = Array.isArray(data?.items) ? data.items : [];
          setRemoteSuggestions(list.slice(0, 30));
        }
      } catch {
        if (!cancelled) setRemoteSuggestions([]);
      } finally {
        if (!cancelled) setSuggestLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form.nom]);

  const suggestions = useMemo(() => {
    const merged = [...localSuggestions, ...remoteSuggestions];
    const seen = new Set();
    const out = [];
    for (const item of merged) {
      const key = `${String(item?.code ?? item?.codeBarre ?? "").trim()}|${String(
        item?.nom ?? ""
      )
        .trim()
        .toLowerCase()}|${String(
        item?.principeActif ?? ""
      )
        .trim()
        .toLowerCase()}|${String(item?.dosage ?? "")
        .trim()
        .toLowerCase()}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= 30) break;
    }
    return out;
  }, [localSuggestions, remoteSuggestions]);

  useEffect(() => {
    function onDocClick(e) {
      if (
        suggestRef.current &&
        !suggestRef.current.contains(e.target) &&
        nomInputRef.current &&
        !nomInputRef.current.contains(e.target)
      ) {
        setSuggestOpen(false);
      }
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  const onScan = useCallback(async (text) => {
    const scanned = text.trim();
    const normalizedCode = extractBestBarcodeCandidate(scanned);
    setScanOpen(false);
    try {
      const payload = await apiFetch("/scan", {
        method: "POST",
        body: JSON.stringify({ code_barre: normalizedCode }),
      });
      const med = payload?.medicament;
      const candidateName = med?.nom || payload?.querySuggestion || "";
      const parsed = splitCommercialNameAndDosage(candidateName, med?.dosage);
      const safeName =
        parsed.nom && !isBarcodeLike(parsed.nom) ? parsed.nom : "";
      setForm((f) => ({
        ...f,
        nom: safeName || f.nom,
        principeActif: med?.principeActif || f.principeActif,
        dosage: parsed.dosage || f.dosage,
      }));
      setMsg({
        type: "ok",
        text:
          payload?.status === "local"
            ? "Médicament reconnu en base locale : formulaire pré-rempli."
            : payload?.status === "external"
              ? "Médicament trouvé dans les catalogues locaux (JSON/XLSX/PDF) : vérifiez les champs avant enregistrement."
              : "Code scanné, mais fiche introuvable dans les données locales. Saisissez le nom, le principe actif et le dosage manuellement.",
      });
    } catch {
      setMsg({
        type: "ok",
        text: "Scan capturé, mais l’API de scan est indisponible. Saisissez les champs manuellement.",
      });
    }
    setTimeout(() => nomInputRef.current?.focus(), 100);
  }, []);

  function applySuggestion(m) {
    setForm((f) => ({
      ...f,
      nom: m.nom || f.nom,
      principeActif: m.principeActif || f.principeActif,
      dosage: m.dosage || f.dosage,
    }));
    setSuggestOpen(false);
    setMsg({
      type: "ok",
      text: "Fiche reprise du stock — vérifiez la quantité et la date d’expiration.",
    });
  }

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setMsg({ type: "", text: "" });
    setLoading(true);
    try {
      await apiFetch("/medicaments", {
        method: "POST",
        body: JSON.stringify({
          nom: form.nom.trim(),
          principeActif: form.principeActif.trim(),
          dosage: form.dosage.trim(),
          numeroLot: form.numeroLot.trim(),
          quantite: Number(form.quantite),
          dateExpiration: form.dateExpiration,
        }),
      });
      setMsg({ type: "ok", text: "Médicament enregistré." });
      setForm((prev) => ({
        ...empty,
        nom: prev.nom,
        principeActif: prev.principeActif,
        dosage: "",
      }));
      const list = await apiFetch("/medicaments");
      if (Array.isArray(list)) setCatalog(list);
    } catch (err) {
      setMsg({
        type: "err",
        text:
          typeof err.body?.error === "string"
            ? err.body.error
            : "Enregistrement impossible.",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-6">
        Ajouter un médicament
      </h1>
      {catalog.length === 0 && (
        <p className="mb-4 rounded-xl border border-clinic-200 bg-clinic-50 px-4 py-3 text-sm text-clinic-900">
          Aucun stock local détecté. Scannez un médicament pour pré-remplir les
          champs, puis ajoutez quantité et expiration.
        </p>
      )}

      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              setScanOpen(true);
              setMsg({ type: "", text: "" });
            }}
            className="rounded-xl border-2 border-dashed border-clinic-300 bg-clinic-50 py-4 text-sm font-semibold text-clinic-800 hover:bg-clinic-100"
          >
            📷 Scanner le code-barres
            <span className="mt-1 block text-xs font-normal text-clinic-700/90">
              EAN-13 / UPC si visible
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMsg({
                type: "ok",
                text: "Saisie manuelle : remplissez les champs ci-dessous (obligatoire sur le terrain).",
              });
              nomInputRef.current?.focus();
            }}
            className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 py-4 text-sm font-semibold text-slate-800 hover:bg-slate-100"
          >
            ✍️ Saisir sans scanner
            <span className="mt-1 block text-xs font-normal text-slate-600">
              Toujours possible
            </span>
          </button>
        </div>

        <div className="relative">
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Nom commercial *
          </label>
          <input
            ref={nomInputRef}
            required
            autoComplete="off"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={form.nom}
            onChange={(e) => {
              update("nom", e.target.value);
              setSuggestOpen(true);
            }}
            onFocus={() => setSuggestOpen(true)}
            placeholder="Ex. Doliprane 1000"
          />
          {suggestOpen && form.nom.trim().length >= 2 && (
            <ul
              ref={suggestRef}
              className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
              role="listbox"
            >
              <li className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                Suggestions base locale
              </li>
              {suggestLoading && (
                <li className="px-3 py-2 text-xs text-slate-500">
                  Chargement des suggestions…
                </li>
              )}
              {!suggestLoading && suggestions.length === 0 && (
                <li className="px-3 py-2 text-xs text-slate-500">
                  Aucune suggestion pour cette saisie.
                </li>
              )}
              {suggestions.map((m) => (
                <li key={`${m.id ?? "api"}-${m.nom}-${m.dosage ?? ""}`}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left text-sm hover:bg-clinic-50"
                    onClick={() => applySuggestion(m)}
                  >
                    <span className="font-medium text-slate-900">{m.nom}</span>
                    <span className="block text-xs text-slate-500">
                      {m.principeActif || "Principe actif non précisé"}
                      {m.dosage ? ` · ${m.dosage}` : ""}
                      {" · Base locale"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Principe actif *
          </label>
          <input
            required
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={form.principeActif}
            onChange={(e) => update("principeActif", e.target.value)}
            placeholder="Ex. Paracétamol"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Dosage *
          </label>
          <input
            required
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={form.dosage}
            onChange={(e) => update("dosage", e.target.value)}
            placeholder="Ex. 1 g"
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Quantité *
            </label>
            <input
              required
              type="number"
              min={0}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={form.quantite}
              onChange={(e) => update("quantite", e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Numéro de lot (optionnel)
            </label>
            <input
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={form.numeroLot}
              onChange={(e) => update("numeroLot", e.target.value)}
              placeholder="Ex. LOT-2026-04 (auto si vide)"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Date d’expiration *
          </label>
          <input
            required
            type="month"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm max-w-[220px]"
            value={form.dateExpiration}
            onChange={(e) => update("dateExpiration", e.target.value)}
          />
        </div>

        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          Astuce: après enregistrement, le nom et le principe actif sont conservés
          automatiquement pour accélérer l'ajout d'un autre dosage.
        </p>

        {msg.text && (
          <p
            className={`text-sm rounded-lg px-3 py-2 ${
              msg.type === "ok"
                ? "bg-emerald-50 text-emerald-800"
                : "bg-red-50 text-red-700"
            }`}
          >
            {msg.text}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-clinic-600 text-white font-semibold py-3 text-sm hover:bg-clinic-700 disabled:opacity-50"
        >
          {loading ? "Enregistrement…" : "Enregistrer"}
        </button>
      </form>

      {scanOpen && (
        <BarcodeScanner onDetected={onScan} onClose={() => setScanOpen(false)} />
      )}
    </div>
  );
}
