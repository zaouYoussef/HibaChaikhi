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

export default function AddMedicamentPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState(empty);
  const [scanOpen, setScanOpen] = useState(false);
  const [msg, setMsg] = useState({ type: "", text: "" });
  const [loading, setLoading] = useState(false);
  const [catalog, setCatalog] = useState([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
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

  const suggestions = useMemo(() => {
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
    const normalizedCode = scanned.replace(/\s+/g, "");
    setScanOpen(false);
    try {
      const payload = await apiFetch("/scan", {
        method: "POST",
        body: JSON.stringify({ code_barre: normalizedCode }),
      });
      const med = payload?.medicament;
      const candidateName = med?.nom || payload?.querySuggestion || "";
      const safeName =
        candidateName && !isBarcodeLike(candidateName) ? candidateName : "";
      setForm((f) => ({
        ...f,
        nom: safeName || f.nom,
        principeActif: med?.principeActif || f.principeActif,
        dosage: med?.dosage || f.dosage,
      }));
      setMsg({
        type: "ok",
        text:
          payload?.status === "local"
            ? "Médicament reconnu en base locale : formulaire pré-rempli."
            : payload?.status === "external"
              ? "Données récupérées via medicament.ma : vérifiez les champs avant enregistrement."
              : "Code scanné, mais fiche introuvable sur medicament.ma. Saisissez le nom, le principe actif et le dosage manuellement.",
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
      nom: m.nom,
      principeActif: m.principeActif,
      dosage: m.dosage,
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
      setForm(empty);
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
        className="max-w-lg space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
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
            placeholder="Ex. Doliprane 1000 ou chiffres du code-barres"
          />
          {suggestOpen && suggestions.length > 0 && (
            <ul
              ref={suggestRef}
              className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
              role="listbox"
            >
              <li className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                Déjà dans le stock (reprise rapide)
              </li>
              {suggestions.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left text-sm hover:bg-clinic-50"
                    onClick={() => applySuggestion(m)}
                  >
                    <span className="font-medium text-slate-900">{m.nom}</span>
                    <span className="block text-xs text-slate-500">
                      {m.principeActif} · {m.dosage}
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
        <div className="grid grid-cols-2 gap-4">
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
