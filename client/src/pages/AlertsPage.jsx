import { useEffect, useState } from "react";
import { apiFetch } from "../api.js";

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function AlertsPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let c = false;
    (async () => {
      try {
        const res = await apiFetch("/alerts?days=30");
        if (!c) setData(res);
      } catch (e) {
        if (!c) setErr(e.message);
      }
    })();
    return () => {
      c = true;
    };
  }, []);

  if (err) {
    return <p className="text-red-600 text-sm">{err}</p>;
  }
  if (!data) {
    return (
      <p className="text-slate-500 text-sm animate-pulse">Chargement…</p>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Alertes</h1>
      <p className="text-slate-600 text-sm mb-6">
        Médicaments expirant dans les {data.days} prochains jours (avec stock
        &gt; 0).
      </p>

      {data.items.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-slate-500 text-sm">
          Aucune alerte pour cette fenêtre.
        </p>
      ) : (
        <ul className="space-y-3">
          {data.items.map((m) => {
            const style =
              m.urgency === "expired"
                ? {
                    container: "border-red-600 bg-red-50",
                    badge: "bg-red-600 text-white",
                    label: "Expiré",
                  }
                : m.urgency === "critical"
                  ? {
                      container: "border-orange-500 bg-orange-50",
                      badge: "bg-orange-600 text-white",
                      label: "< 7 jours",
                    }
                  : {
                      container: "border-amber-500 bg-amber-50",
                      badge: "bg-amber-600 text-white",
                      label: "< 30 jours",
                    };
            return (
              <li
                key={m.id}
                className={`rounded-2xl border-l-4 px-4 py-4 shadow-sm ${style.container}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-slate-900">{m.nom}</p>
                    <p className="text-sm text-slate-600">
                      {m.principeActif} · {m.dosage}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${style.badge}`}
                  >
                    {style.label}
                  </span>
                </div>
                <p className="mt-2 text-sm">
                  <span className="text-slate-500">Lot : </span>
                  <strong>{m.numeroLot}</strong>
                  <span className="text-slate-400"> · </span>
                  <span className="text-slate-500">Expiration : </span>
                  <strong>{formatDate(m.dateExpiration)}</strong>
                  <span className="text-slate-500"> · Stock : </span>
                  <strong>{m.quantite}</strong>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
