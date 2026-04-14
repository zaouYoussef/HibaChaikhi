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
  const [stockFilter, setStockFilter] = useState("all");
  const [medQuery, setMedQuery] = useState("");
  const [actionMsg, setActionMsg] = useState({ type: "", text: "" });

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

  const now = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const lotsFlat = useMemo(() => {
    if (!sortedMeds.length) return [];
    return sortedMeds.flatMap((m) =>
      (m.lots ?? [])
        .filter((lot) => Number(lot.quantite) > 0)
        .map((lot) => ({
          id: `${m.id}-${lot.id}`,
          medicamentId: m.id,
          nom: m.nom,
          principeActif: m.principeActif,
          dosage: m.dosage,
          stockTotal: Number(m.quantite ?? 0),
          stockStatus: m.stockStatus,
          lotQuantite: Number(lot.quantite ?? 0),
          numeroLot: lot.numeroLot,
          dateExpiration: lot.dateExpiration,
        }))
    );
  }, [sortedMeds]);

  const dashboardMetrics = useMemo(() => {
    const totalUnites = sortedMeds.reduce(
      (sum, m) => sum + Number(m.quantite ?? 0),
      0
    );
    const totalLots = lotsFlat.length;
    const expiredLots = lotsFlat.filter((l) => {
      const exp = new Date(l.dateExpiration ?? "9999-12-31");
      exp.setHours(0, 0, 0, 0);
      return exp < now;
    }).length;
    const in7Days = lotsFlat.filter((l) => {
      const exp = new Date(l.dateExpiration ?? "9999-12-31");
      exp.setHours(0, 0, 0, 0);
      const delta = exp.getTime() - now.getTime();
      return delta >= 0 && delta <= 7 * 24 * 60 * 60 * 1000;
    }).length;
    const criticalMeds = sortedMeds.filter(
      (m) => m.stockStatus === "critical"
    ).length;
    const lowMeds = sortedMeds.filter((m) => m.stockStatus === "low").length;
    return {
      totalUnites,
      totalLots,
      expiredLots,
      in7Days,
      criticalMeds,
      lowMeds,
    };
  }, [sortedMeds, lotsFlat, now]);

  const urgentLots = useMemo(() => {
    return [...lotsFlat]
      .filter((l) => {
        const exp = new Date(l.dateExpiration ?? "9999-12-31");
        exp.setHours(0, 0, 0, 0);
        return exp <= new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      })
      .sort(
        (a, b) =>
          new Date(a.dateExpiration ?? "9999-12-31").getTime() -
          new Date(b.dateExpiration ?? "9999-12-31").getTime()
      )
      .slice(0, 6);
  }, [lotsFlat, now]);

  const criticalStockRows = useMemo(() => {
    return sortedMeds
      .filter((m) => m.stockStatus === "critical" || m.stockStatus === "low")
      .sort((a, b) => Number(a.quantite ?? 0) - Number(b.quantite ?? 0))
      .slice(0, 8);
  }, [sortedMeds]);

  const filteredMeds = useMemo(() => {
    const q = medQuery.trim().toLowerCase();
    return sortedMeds
      .filter((m) => (stockFilter === "all" ? true : m.stockStatus === stockFilter))
      .filter((m) => {
        if (!q) return true;
        return (
          String(m.nom ?? "").toLowerCase().includes(q) ||
          String(m.principeActif ?? "").toLowerCase().includes(q) ||
          String(m.dosage ?? "").toLowerCase().includes(q)
        );
      });
  }, [sortedMeds, stockFilter, medQuery]);

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
      label: "Unités en stock",
      value: dashboardMetrics.totalUnites,
      hint: `${dashboardMetrics.totalLots} lots actifs`,
      color: "bg-indigo-500",
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
    {
      label: "Critiques (≤ 4)",
      value: dashboardMetrics.criticalMeds,
      hint: "Médicaments à réapprovisionner vite",
      color: "bg-red-500",
    },
  ];

  async function deleteMedicament(item) {
    if (!confirm(`Supprimer ${item.nom} (${item.dosage}) ?`)) return;
    setActionMsg({ type: "", text: "" });
    try {
      await apiFetch(`/medicaments/${item.id}`, { method: "DELETE" });
      const [s, list] = await Promise.all([
        apiFetch("/dashboard/stats"),
        apiFetch("/medicaments"),
      ]);
      setStats(s);
      setMedicaments(Array.isArray(list) ? list : []);
      setActionMsg({
        type: "ok",
        text: `${item.nom} supprimé avec succès.`,
      });
    } catch (e) {
      setActionMsg({
        type: "err",
        text: e?.body?.error || e?.message || "Suppression impossible.",
      });
    }
  }

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
      {actionMsg.text && (
        <p
          className={`mb-4 rounded-lg px-3 py-2 text-sm ${
            actionMsg.type === "err"
              ? "bg-red-50 text-red-700"
              : "bg-emerald-50 text-emerald-800"
          }`}
        >
          {actionMsg.text}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
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

      <section className="mt-8 grid gap-4 lg:grid-cols-2">
        <article className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">
            Priorités péremption (0-7 jours)
          </h2>
          <p className="mt-1 text-xs text-amber-800">
            {dashboardMetrics.expiredLots} lots déjà expirés,{" "}
            {dashboardMetrics.in7Days} lots expirent dans 7 jours.
          </p>
          {urgentLots.length === 0 ? (
            <p className="mt-3 text-xs text-amber-800/80">
              Aucun lot urgent dans la semaine.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {urgentLots.map((l) => (
                <li
                  key={l.id}
                  className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs"
                >
                  <p className="font-semibold text-slate-900">{l.nom}</p>
                  <p className="text-slate-600">
                    Lot {l.numeroLot || "—"} · {l.lotQuantite} · exp.{" "}
                    {formatDate(l.dateExpiration)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <h2 className="text-sm font-semibold text-rose-900">
            Réapprovisionnement prioritaire
          </h2>
          <p className="mt-1 text-xs text-rose-800">
            Liste triée par stock le plus faible.
          </p>
          {criticalStockRows.length === 0 ? (
            <p className="mt-3 text-xs text-rose-800/80">
              Aucun médicament en faible/critique.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {criticalStockRows.map((m) => (
                <li
                  key={m.id}
                  className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs"
                >
                  <p className="font-semibold text-slate-900">
                    {m.nom} · {m.dosage}
                  </p>
                  <p className="text-slate-600">
                    Stock {m.quantite} · {m.principeActif}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-slate-900 mb-1">
          Tous les médicaments saisis
        </h2>
        <p className="text-sm text-slate-500 mb-4">
          Tri par date d’expiration — la plus proche en premier.
        </p>
        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 md:flex-row md:items-center md:justify-between">
          <input
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm md:max-w-sm"
            placeholder="Rechercher un médicament..."
            value={medQuery}
            onChange={(e) => setMedQuery(e.target.value)}
          />
          <p className="text-xs text-slate-600">
            {filteredMeds.length} résultat{filteredMeds.length > 1 ? "s" : ""}
          </p>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {[
            { key: "all", label: "Tous" },
            { key: "ok", label: "OK" },
            { key: "low", label: "Faible" },
            { key: "critical", label: "Critique" },
          ].map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStockFilter(f.key)}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                stockFilter === f.key
                  ? "border-clinic-600 bg-clinic-600 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {filteredMeds.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600">
            Aucun stock local pour le moment. Commencez par scanner et enregistrer
            vos premiers médicaments depuis la page Ajouter.{" "}
            <Link to="/ajouter" className="font-medium text-clinic-700 underline">
              Ajouter un médicament
            </Link>
          </p>
        ) : (
          <>
            <div className="space-y-2 md:hidden">
              {filteredMeds.map((m) => {
                const exp = new Date(m.dateExpiration ?? "9999-12-31");
                exp.setHours(0, 0, 0, 0);
                const expired = exp < now;
                const soon =
                  !expired &&
                  exp.getTime() - now.getTime() <= 30 * 24 * 60 * 60 * 1000;
                const level =
                  m.stockStatus === "critical"
                    ? { label: "Critique", cls: "bg-red-100 text-red-700" }
                    : m.stockStatus === "low"
                      ? { label: "Faible", cls: "bg-amber-100 text-amber-700" }
                      : { label: "OK", cls: "bg-emerald-100 text-emerald-700" };
                return (
                  <article
                    key={m.id}
                    className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold text-slate-900">{m.nom}</p>
                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ${level.cls}`}
                      >
                        {level.label}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      {m.principeActif} · {m.dosage}
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                      <p>
                        <span className="text-slate-500">Stock:</span>{" "}
                        <span className="font-semibold text-slate-900">
                          {m.quantite}
                        </span>
                      </p>
                      <p>
                        <span className="text-slate-500">Expiration:</span>{" "}
                        <span className="font-semibold text-slate-900">
                          {formatDate(m.dateExpiration)}
                        </span>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => deleteMedicament(m)}
                      className="mt-2 inline-flex rounded-md bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
                    >
                      Supprimer
                    </button>
                    {(expired || soon) && (
                      <p
                        className={`mt-2 text-xs font-semibold ${
                          expired ? "text-red-700" : "text-amber-700"
                        }`}
                      >
                        {expired ? "Expiré" : "Expire dans moins de 30 jours"}
                      </p>
                    )}
                  </article>
                );
              })}
            </div>

            <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm md:block">
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
                {filteredMeds.map((m) => {
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
                        <button
                          type="button"
                          onClick={() => deleteMedicament(m)}
                          className="ml-3 text-xs font-semibold text-red-700 hover:underline"
                        >
                          Supprimer
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </>
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
