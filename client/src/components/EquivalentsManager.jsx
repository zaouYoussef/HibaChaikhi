import { useEffect, useState } from "react";
import { apiFetch } from "../api.js";

export default function EquivalentsManager() {
  const [list, setList] = useState([]);
  const [principeActif, setPrincipeActif] = useState("");
  const [nomMedicament, setNomMedicament] = useState("");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

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
    setMsg("");
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
      setMsg("Référence ajoutée.");
      load();
    } catch (err) {
      setMsg(err.message || "Erreur");
    }
  }

  async function remove(id) {
    if (!confirm("Supprimer cette entrée ?")) return;
    try {
      await apiFetch(`/equivalents/${id}`, { method: "DELETE" });
      load();
    } catch {
      setMsg("Suppression impossible.");
    }
  }

  return (
    <div className="mt-12 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-bold text-slate-900 mb-1">
        Équivalences (références)
      </h2>
      <p className="text-sm text-slate-600 mb-4">
        Associez un nom de médicament à un principe actif pour enrichir les
        suggestions quand le stock principal est épuisé.
      </p>

      <form onSubmit={handleAdd} className="flex flex-col sm:flex-row gap-2 mb-6">
        <input
          required
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
          placeholder="Principe actif"
          value={principeActif}
          onChange={(e) => setPrincipeActif(e.target.value)}
        />
        <input
          required
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
          placeholder="Nom médicament équivalent"
          value={nomMedicament}
          onChange={(e) => setNomMedicament(e.target.value)}
        />
        <button
          type="submit"
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900"
        >
          Ajouter
        </button>
      </form>
      {msg && (
        <p className="text-sm text-emerald-700 mb-3">{msg}</p>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Chargement…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-slate-500">Aucune entrée pour l’instant.</p>
      ) : (
        <ul className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
          {list.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <span>
                <strong>{row.nomMedicament}</strong>
                <span className="text-slate-500"> — {row.principeActif}</span>
              </span>
              <button
                type="button"
                onClick={() => remove(row.id)}
                className="text-xs text-red-600 hover:underline"
              >
                Supprimer
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
