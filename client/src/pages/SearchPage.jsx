import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api.js";

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", {
    month: "short",
    year: "numeric",
  });
}

export default function SearchPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [result, setResult] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [error, setError] = useState("");
  const [useMsg, setUseMsg] = useState("");
  const lastSearchedRef = useRef("");

  async function runSearch(rawQuery) {
    const query = rawQuery.trim();
    if (!query) {
      setResult(null);
      setError("");
      return;
    }
    setError("");
    setUseMsg("");
    setLoading(true);
    try {
      const data = await apiFetch(
        `/search?q=${encodeURIComponent(query)}`
      );
      setResult(data);
      lastSearchedRef.current = query;
    } catch (err) {
      setError(err.message || "Erreur recherche");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  async function search(e) {
    e.preventDefault();
    await runSearch(q);
  }

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setResult(null);
      setError("");
      return;
    }
    if (query.length < 2 || query === lastSearchedRef.current) return;
    const timer = setTimeout(() => {
      runSearch(query);
    }, 350);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    window.history.pushState({ __inAppBackGuard: true }, "", window.location.href);
    const onPopState = () => {
      navigate("/", { replace: true });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navigate]);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setSuggestions([]);
      setSuggestLoading(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSuggestLoading(true);
      try {
        const data = await apiFetch(`/suggest?q=${encodeURIComponent(query)}`);
        if (!cancelled) {
          setSuggestions(Array.isArray(data?.items) ? data.items : []);
        }
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setSuggestLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  async function applySuggestion(item) {
    const nextQuery = item?.nom?.trim() || q;
    setQ(nextQuery);
    setShowSuggestions(false);
    await runSearch(nextQuery);
  }

  async function deliver(id) {
    setUseMsg("");
    try {
      await apiFetch(`/medicaments/${id}/use`, {
        method: "PUT",
        body: JSON.stringify({ quantite: 1 }),
      });
      setUseMsg("Médicament délivré. Stock et historique mis à jour.");
      await runSearch(q);
    } catch (err) {
      setUseMsg(err.body?.error || err.message || "Échec délivrance");
    }
  }

  const dispo = result?.status === "disponible";
  const equivalentDispo = result?.status === "equivalent_disponible";

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-1">
        Recherche médicament
      </h1>
      <p className="text-slate-600 text-sm mb-4">
        Mode pharmacien rapide: recherche + délivrance en quelques secondes.
      </p>

      <form
        onSubmit={search}
        className="mb-5 flex max-w-xl flex-col gap-2 sm:flex-row"
      >
        <div className="relative flex-1">
          <input
            className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm"
            placeholder="Nom ou principe actif…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => {
              setTimeout(() => setShowSuggestions(false), 120);
            }}
          />
          {showSuggestions && (suggestions.length > 0 || suggestLoading) && (
            <ul className="absolute z-20 mt-1 w-full rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
              {suggestLoading && (
                <li className="px-4 py-2 text-xs text-slate-500">Suggestions…</li>
              )}
              {!suggestLoading &&
                suggestions.map((s, idx) => (
                  <li key={`${s.nom}-${s.dosage}-${idx}`}>
                    <button
                      type="button"
                      className="w-full px-4 py-2 text-left hover:bg-clinic-50"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applySuggestion(s)}
                    >
                      <span className="block text-sm font-medium text-slate-900">
                        {s.nom}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {s.principeActif || "Principe actif inconnu"}
                        {s.dosage ? ` · ${s.dosage}` : ""}
                        {" · Base locale"}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
        <button
          type="submit"
          disabled={loading}
          className="rounded-xl bg-clinic-600 px-5 py-3 text-sm font-semibold text-white hover:bg-clinic-700 disabled:opacity-50 sm:w-auto"
        >
          {loading ? "…" : "Rechercher"}
        </button>
      </form>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}
      {useMsg && (
        <p className="text-sm text-emerald-800 bg-emerald-50 rounded-lg px-3 py-2 mb-4">
          {useMsg}
        </p>
      )}

      {result && (
        <div className="space-y-6">
          <div
            className={`rounded-2xl border-2 p-5 ${
              dispo
                ? "border-emerald-300 bg-emerald-50/80"
                : equivalentDispo
                  ? "border-amber-300 bg-amber-50/80"
                : "border-amber-300 bg-amber-50/80"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span
                className={`inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${
                  dispo
                    ? "bg-emerald-600 text-white"
                    : equivalentDispo
                      ? "bg-amber-600 text-white"
                      : "bg-amber-600 text-white"
                }`}
              >
                {dispo ? "Disponible" : equivalentDispo ? "Équivalent dispo" : "Non dispo"}
              </span>
            </div>

            {(dispo || equivalentDispo) && result.recommended && (
              <>
                <p
                  className={`mb-2 text-sm font-semibold ${
                    equivalentDispo ? "text-amber-900" : "text-emerald-900"
                  }`}
                >
                  {equivalentDispo
                    ? "Médicament demandé absent: équivalent à délivrer en priorité"
                    : "Lot à délivrer en priorité (expiration la plus proche)"}
                </p>
                <div
                  className={`rounded-xl bg-white p-4 ${
                    equivalentDispo
                      ? "border border-amber-200"
                      : "border border-emerald-200"
                  }`}
                >
                  <p className="font-bold text-slate-900">
                    {result.recommended.nom}
                  </p>
                  <p className="text-sm text-slate-600 mt-1">
                    {result.recommended.principeActif} ·{" "}
                    {result.recommended.dosage}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-4 text-sm">
                    <span>
                      <span className="text-slate-500">Stock : </span>
                      <strong>{result.recommended.quantite}</strong>
                    </span>
                    <span>
                      <span className="text-slate-500">Lot : </span>
                      <strong>{result.recommended.numeroLot || "—"}</strong>
                    </span>
                    <span>
                      <span className="text-slate-500">Expiration : </span>
                      <strong>
                        {formatDate(result.recommended.dateExpiration)}
                      </strong>
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => deliver(result.recommended.id)}
                    className={`mt-4 w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white ${
                      equivalentDispo
                        ? "bg-amber-600 hover:bg-amber-700"
                        : "bg-emerald-600 hover:bg-emerald-700"
                    }`}
                  >
                    Donner 1 unité
                  </button>
                </div>
              </>
            )}

            {!dispo && !equivalentDispo && (
              <p className="text-lg font-semibold text-amber-900">
                {result.message || "Médicament non disponible"}
              </p>
            )}

            {(dispo || equivalentDispo) && result.items && result.items.length > 1 && (
              <div className="mt-4">
                <p
                  className={`mb-2 text-xs font-medium ${
                    equivalentDispo ? "text-amber-800" : "text-emerald-800"
                  }`}
                >
                  {equivalentDispo
                    ? "Autres lots d'équivalents disponibles"
                    : "Autres lots disponibles (triés par expiration)"}
                </p>
                <ul className="space-y-2">
                  {result.items.slice(1).map((it) => (
                    <li
                      key={it.id}
                      className={`flex flex-col items-start gap-1 rounded-lg bg-white/80 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between ${
                        equivalentDispo ? "border border-amber-100" : "border border-emerald-100"
                      }`}
                    >
                      <div>
                        <span>{it.nom}</span>
                        <span className="block text-xs text-slate-500">
                          {it.principeActif || "Principe actif inconnu"}
                          {it.dosage ? ` · ${it.dosage}` : ""}
                        </span>
                      </div>
                      <span className="text-slate-600">
                        Lot {it.numeroLot || "—"} · {it.quantite} ·{" "}
                        {formatDate(it.dateExpiration)}
                      </span>
                      <button
                        type="button"
                        onClick={() => deliver(it.id)}
                        className="text-xs font-semibold text-emerald-700 underline"
                      >
                        Donner
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {!dispo && result.equivalents && result.equivalents.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-slate-800 mb-2">
                Équivalents suggérés (même principe actif ou références)
              </h2>
              <ul className="space-y-2">
                {result.equivalents.map((eq) => (
                  <li
                    key={`${eq.kind}-${eq.id}-${eq.lotId ?? "ref"}`}
                    className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm"
                  >
                    <span className="font-medium">{eq.nom}</span>
                    <span className="text-slate-500"> — {eq.principeActif}</span>
                    {eq.kind === "stock" && (
                      <span className="block text-xs text-slate-600 mt-1">
                        En stock : {eq.quantite} · exp.{" "}
                        {formatDate(eq.dateExpiration)}
                      </span>
                    )}
                    {eq.kind === "reference" && (
                      <span className="block text-xs text-slate-500 mt-1">
                        Référence équivalence
                      </span>
                    )}
                    {eq.kind === "stock" && (
                      <button
                        type="button"
                        onClick={() => deliver(eq.id)}
                        className="mt-2 text-xs font-semibold text-clinic-700 underline"
                      >
                        Donner 1 unité
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
