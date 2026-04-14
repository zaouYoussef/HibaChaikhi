import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api.js";
import EquivalentsManager from "../components/EquivalentsManager.jsx";

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("fr-FR", {
    month: "short",
    year: "numeric",
  });
}

export default function DashboardPage() {
  const [stats, setStats] = useState(null);
  const [medicaments, setMedicaments] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, list] = await Promise.all([
          apiFetch("/dashboard/stats"),
          apiFetch("/medicaments"),
        ]);
        if (!cancelled) {
          setStats(s);
          setMedicaments(Array.isArray(list) ? list : []);
        }
      } catch (e) {
        if (!cancelled) setErr(e.message || "Erreur chargement");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedMeds = useMemo(() => {
    if (!medicaments?.length) return [];
    return [...medicaments].sort(
      (a, b) =>
        new Date(a.dateExpiration ?? "9999-12-31").getTime() -
        new Date(b.dateExpiration ?? "9999-12-31").getTime()
    );
  }, [medicaments]);

  if (err) {
    return (
      <p className="text-red-600 text-sm">
        {err}{" "}
        <Link to="/login" className="underline">
          Reconnectez-vous
        </Link>
      </p>
    );
  }

  if (!stats || medicaments === null) {
    return (
      <p className="text-slate-500 text-sm animate-pulse">Chargement…</p>
    );
  }

  const cards = [
    {
      label: "Total médicaments (lignes)",
      value: stats.totalMedicaments,
      hint: "Références enregistrées",
      color: "bg-clinic-500",
    },
    {
      label: "Expire dans 30 jours",
      value: stats.bientotExpires,
      hint: "Lots encore en stock",
      color: "bg-amber-500",
    },
    {
      label: "Stock faible (≤ 10)",
      value: stats.stockFaible,
      hint: "Unités restantes",
      color: "bg-rose-500",
    },
  ];

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-1">
        Tableau de bord
      </h1>
      <p className="text-base font-semibold text-clinic-800 mb-1">
        Hiba CHAIKHI
      </p>
      <p className="text-slate-600 text-sm mb-8">
        Vue d’ensemble avant et pendant la caravane.
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <div className={`h-1 w-10 rounded ${c.color} mb-3`} />
            <p className="text-3xl font-bold text-slate-900 tabular-nums">
              {c.value}
            </p>
            <p className="text-sm font-medium text-slate-800 mt-1">{c.label}</p>
            <p className="text-xs text-slate-500 mt-1">{c.hint}</p>
          </div>
        ))}
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-slate-900 mb-1">
          Tous les médicaments saisis
        </h2>
        <p className="text-sm text-slate-500 mb-4">
          Tri par date d’expiration — la plus proche en premier.
        </p>

        {sortedMeds.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600">
            Aucun stock local pour le moment. Commencez par scanner et enregistrer
            vos premiers médicaments depuis la page Ajouter.{" "}
            <Link to="/ajouter" className="font-medium text-clinic-700 underline">
              Ajouter un médicament
            </Link>
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600">
                  <th className="px-4 py-3">Date d’expiration</th>
                  <th className="px-4 py-3">Nom</th>
                  <th className="px-4 py-3">Principe actif</th>
                  <th className="px-4 py-3">Dosage</th>
                  <th className="px-4 py-3 text-right">Stock</th>
                  <th className="px-4 py-3">Niveau</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedMeds.map((m) => {
                  const exp = new Date(m.dateExpiration ?? "9999-12-31");
                  exp.setHours(0, 0, 0, 0);
                  const expired = exp < now;
                  const soon =
                    !expired &&
                    exp.getTime() - now.getTime() <=
                      30 * 24 * 60 * 60 * 1000;
                  const level =
                    m.stockStatus === "critical"
                      ? { label: "Critique", cls: "bg-red-100 text-red-700" }
                      : m.stockStatus === "low"
                        ? { label: "Faible", cls: "bg-amber-100 text-amber-700" }
                        : { label: "OK", cls: "bg-emerald-100 text-emerald-700" };
                  return (
                    <tr
                      key={m.id}
                      className={
                        expired
                          ? "bg-red-50/80"
                          : soon
                            ? "bg-amber-50/50"
                            : ""
                      }
                    >
                      <td className="px-4 py-3 tabular-nums text-slate-900 whitespace-nowrap">
                        {formatDate(m.dateExpiration)}
                        {expired && (
                          <span className="ml-2 text-xs font-medium text-red-700">
                            Expiré
                          </span>
                        )}
                        {soon && !expired && (
                          <span className="ml-2 text-xs font-medium text-amber-800">
                            &lt; 30 j.
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {m.nom}
                      </td>
                      <td className="px-4 py-3 text-slate-700">{m.principeActif}</td>
                      <td className="px-4 py-3 text-slate-600">{m.dosage}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-900">
                        {m.quantite}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${level.cls}`}
                        >
                          {level.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          to="/ajouter"
          className="inline-flex items-center justify-center rounded-xl bg-clinic-600 px-5 py-3 text-sm font-semibold text-white hover:bg-clinic-700"
        >
          Ajouter un médicament
        </Link>
        <Link
          to="/recherche"
          className="inline-flex items-center justify-center rounded-xl border border-clinic-200 bg-clinic-50 px-5 py-3 text-sm font-semibold text-clinic-900 hover:bg-clinic-100"
        >
          Recherche pharmacien
        </Link>
        <Link
          to="/alertes"
          className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50"
        >
          Voir les alertes
        </Link>
      </div>

      <EquivalentsManager />
    </div>
  );
}
