import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Token manquant" });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    let resolvedUser = null;

    // Prefer email lookup to avoid stale `sub` after DB reseed/id recycling.
    if (decoded?.email) {
      resolvedUser = await prisma.user.findUnique({
        where: { email: String(decoded.email) },
        select: { id: true, email: true, name: true },
      });
    }
    if (!resolvedUser && decoded?.sub) {
      resolvedUser = await prisma.user.findUnique({
        where: { id: String(decoded.sub) },
        select: { id: true, email: true, name: true },
      });
    }
    if (!resolvedUser) {
      return res.status(401).json({ error: "Utilisateur du token introuvable" });
    }

    req.user = {
      ...decoded,
      sub: resolvedUser.id,
      email: resolvedUser.email,
      name: resolvedUser.name ?? "",
    };
    next();
  } catch {
    return res.status(401).json({ error: "Token invalide ou expiré" });
  }
}
