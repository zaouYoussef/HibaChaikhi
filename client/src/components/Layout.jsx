import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

const linkClass = ({ isActive }) =>
  `flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
    isActive
      ? "bg-clinic-700 text-white shadow"
      : "text-slate-600 hover:bg-clinic-50 hover:text-clinic-800"
  }`;

export default function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      <aside className="bg-white border-b md:border-b-0 md:border-r border-slate-200 md:w-56 shrink-0">
        <div className="p-4 border-b border-slate-100">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Caravane
          </p>
          <p className="font-semibold text-clinic-800 truncate">
            {user?.name?.trim() || user?.email}
          </p>
        </div>
        <nav className="p-2 flex md:flex-col gap-1 overflow-x-auto md:overflow-visible">
          <NavLink to="/" end className={linkClass}>
            Tableau de bord
          </NavLink>
          <NavLink to="/ajouter" className={linkClass}>
            Ajouter
          </NavLink>
          <NavLink to="/recherche" className={linkClass}>
            Recherche
          </NavLink>
          <NavLink to="/historique" className={linkClass}>
            Historique
          </NavLink>
          <NavLink to="/alertes" className={linkClass}>
            Alertes
          </NavLink>
        </nav>
        <div className="p-2 hidden md:block">
          <button
            type="button"
            onClick={logout}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            Déconnexion
          </button>
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-8 max-w-4xl w-full mx-auto">
        <Outlet />
      </main>
      <div className="md:hidden p-3 border-t border-slate-200 bg-white">
        <button
          type="button"
          onClick={logout}
          className="w-full rounded-lg bg-slate-100 py-2 text-sm font-medium text-slate-700"
        >
          Déconnexion
        </button>
      </div>
    </div>
  );
}
