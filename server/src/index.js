import "dotenv/config";
import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import medicamentsRoutes, {
  autocompleteMedicaments,
  searchMedicaments,
  suggestMedicaments,
} from "./routes/medicaments.js";
import alertsRoutes from "./routes/alerts.js";
import equivalentsRoutes from "./routes/equivalents.js";
import dashboardRoutes from "./routes/dashboard.js";
import scanRoutes from "./routes/scan.js";
import historyRoutes from "./routes/history.js";
import { authMiddleware } from "./middleware/auth.js";

if (!process.env.DATABASE_URL) {
  console.error(
    "[config] DATABASE_URL est manquant. Copiez server/.env.example vers server/.env (ex. file:./prisma/dev.db pour SQLite)."
  );
  process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error("Origine non autorisée"));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "caravane-medicale" });
});

app.use("/auth", authRoutes);

app.use(authMiddleware);
app.get("/search", searchMedicaments);
app.get("/suggest", suggestMedicaments);
app.get("/autocomplete", autocompleteMedicaments);
app.use("/scan", scanRoutes);
app.use("/medicaments", medicamentsRoutes);
app.use("/alerts", alertsRoutes);
app.use("/equivalents", equivalentsRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/history", historyRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Erreur serveur" });
});

app.listen(PORT, () => {
  console.log(`API écoute sur http://localhost:${PORT}`);
});
