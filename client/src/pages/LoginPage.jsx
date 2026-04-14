import { useState } from "react";
import { Navigate } from "react-router-dom";
import { apiFetch } from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";

export default function LoginPage() {
  const { isAuthenticated, login } = useAuth();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (isAuthenticated) return <Navigate to="/" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const path = mode === "login" ? "/auth/login" : "/auth/register";
      const body =
        mode === "login"
          ? { email, password }
          : { email, password, name: name || undefined };
      const data = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      login({ token: data.token, user: data.user });
    } catch (err) {
      const msg =
        err.body?.error?.formErrors?.fieldErrors ||
        err.body?.error ||
        err.message;
      setError(
        typeof msg === "string"
          ? msg
          : "Connexion impossible. Vérifiez vos identifiants."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-gradient-to-b from-clinic-50 to-white">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg border border-slate-100">
        <h1 className="text-2xl font-bold text-clinic-900 text-center mb-1">
          Caravane médicale
        </h1>
        <p className="text-sm text-slate-500 text-center mb-8">
          Stock et délivrance
        </p>

        <div className="flex rounded-lg bg-slate-100 p-1 mb-6">
          <button
            type="button"
            className={`flex-1 rounded-md py-2 text-sm font-medium ${
              mode === "login"
                ? "bg-white shadow text-clinic-800"
                : "text-slate-600"
            }`}
            onClick={() => setMode("login")}
          >
            Connexion
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md py-2 text-sm font-medium ${
              mode === "register"
                ? "bg-white shadow text-clinic-800"
                : "text-slate-600"
            }`}
            onClick={() => setMode("register")}
          >
            Inscription
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === "register" && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Nom (optionnel)
              </label>
              <input
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Email
            </label>
            <input
              type="email"
              required
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Mot de passe
            </label>
            <input
              type="password"
              required
              minLength={6}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
            />
          </div>
          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-clinic-600 text-white font-semibold py-3 text-sm hover:bg-clinic-700 disabled:opacity-50"
          >
            {loading
              ? "…"
              : mode === "login"
                ? "Se connecter"
                : "Créer un compte"}
          </button>
        </form>
      </div>
    </div>
  );
}
