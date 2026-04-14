import { useEffect, useState } from "react";
import { apiFetch } from "../api.js";

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function HistoryPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/history?limit=120");
        if (!cancelled) setData(res);
      } catch (e) {
        if (!cancelled) setErr(e.message || "Erreur chargement historique");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (err) return <p className="text-sm text-red-600">{err}</p>;
  if (!data) return <p className="text-sm text-slate-500">Chargement…</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Historique</h1>
      <p className="text-sm text-slate-600 mb-6">
        Délivrances enregistrées sur le terrain.
      </p>

      {data.items?.length ? (
        <ul className="space-y-3">
          {data.items.map((row) => (
            <li
              key={row.id}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3"
            >
              <p className="font-semibold text-slate-900">
                {row.medicament?.nom} · {row.medicament?.dosage}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {row.medicament?.principeActif} · Lot {row.lot?.numeroLot}
              </p>
              <p className="text-sm mt-2">
                <span className="text-slate-500">Quantité : </span>
                <strong>{row.quantite}</strong>
                <span className="text-slate-400"> · </span>
                <span className="text-slate-500">Utilisateur : </span>
                <strong>{row.utilisateur?.nom}</strong>
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {formatDate(row.date)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">Aucune délivrance pour le moment.</p>
      )}
    </div>
  );
}
