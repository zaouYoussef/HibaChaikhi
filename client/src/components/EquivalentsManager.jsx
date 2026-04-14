import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../api.js";

export default function EquivalentsManager() {
  const [list, setList] = useState([]);
  const [principeActif, setPrincipeActif] = useState("");
  const [nomMedicament, setNomMedicament] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState({ type: "", text: "" });

  const filteredList = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((row) => {
      const pa = String(row.principeActif ?? "").toLowerCase();
      const nom = String(row.nomMedicament ?? "").toLowerCase();
      return pa.includes(q) || nom.includes(q);
    });
  }, [list, query]);

  const groupedByPrincipe = useMemo(() => {
    const map = new Map();
    for (const row of filteredList) {
      const key = String(row.principeActif ?? "").trim() || "Inconnu";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return [...map.entries()]
      .map(([pa, rows]) => [
        pa,
        [...rows].sort((a, b) =>
          String(a.nomMedicament ?? "").localeCompare(
            String(b.nomMedicament ?? ""),
            "fr"
          )
        ),
      ])
      .sort((a, b) => a[0].localeCompare(b[0], "fr"));
  }, [filteredList]);

  async function load() {
    try {
      const rows = await apiFetch("/equivalents");
      setList(rows);
    } catch {
      setList([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e) {
    e.preventDefault();
    setMsg({ type: "", text: "" });
    try {
      await apiFetch("/equivalents", {
        method: "POST",
        body: JSON.stringify({
          principeActif: principeActif.trim(),
          nomMedicament: nomMedicament.trim(),
        }),
      });
      setPrincipeActif("");
      setNomMedicament("");
      setMsg({ type: "ok", text: "Référence ajoutée." });
      load();
    } catch (err) {
      setMsg({ type: "err", text: err.message || "Erreur" });
    }
  }

  async function remove(id) {
    if (!confirm("Supprimer cette entrée ?")) return;
    try {
      await apiFetch(`/equivalents/${id}`, { method: "DELETE" });
      setMsg({ type: "ok", text: "Référence supprimée." });
      load();
    } catch {
      setMsg({ type: "err", text: "Suppression impossible." });
    }
  }

  return (
    <div className="mt-12 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900 mb-1">
        Équivalences (références)
          </h2>
          <p className="text-sm text-slate-600">
            Base de correspondances pour proposer rapidement un substitut valide.
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700">
            {list.length} références
          </span>
          <span className="rounded-full bg-clinic-100 px-3 py-1 font-medium text-clinic-700">
            {groupedByPrincipe.length} principes actifs
          </span>
        </div>
      </div>

      <form onSubmit={handleAdd} className="mb-4 grid gap-2 sm:grid-cols-12">
        <input
          required
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm sm:col-span-4"
          placeholder="Principe actif (ex: Paracétamol)"
          value={principeActif}
          onChange={(e) => setPrincipeActif(e.target.value)}
        />
        <input
          required
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm sm:col-span-6"
          placeholder="Nom médicament équivalent"
          value={nomMedicament}
          onChange={(e) => setNomMedicament(e.target.value)}
        />
        <button
          type="submit"
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 sm:col-span-2"
        >
          Ajouter
        </button>
      </form>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <input
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm sm:max-w-sm"
          placeholder="Rechercher une équivalence..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {msg.text && (
          <p
            className={`text-sm ${
              msg.type === "err" ? "text-red-700" : "text-emerald-700"
            }`}
          >
            {msg.text}
          </p>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Chargement…</p>
      ) : groupedByPrincipe.length === 0 ? (
        <p className="text-sm text-slate-500">Aucune entrée pour l’instant.</p>
      ) : (
        <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
          {groupedByPrincipe.map(([pa, rows]) => (
            <article
              key={pa}
              className="rounded-xl border border-slate-200 bg-slate-50 p-3"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-900">{pa}</h3>
                <span className="rounded-full bg-white px-2 py-1 text-[11px] font-medium text-slate-600">
                  {rows.length} équivalent{rows.length > 1 ? "s" : ""}
                </span>
              </div>
              <ul className="space-y-2">
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <p className="text-sm font-medium text-slate-800">
                      {row.nomMedicament}
                    </p>
                    <button
                      type="button"
                      onClick={() => remove(row.id)}
                      className="inline-flex items-center rounded-md bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
                    >
                      Supprimer
                    </button>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
