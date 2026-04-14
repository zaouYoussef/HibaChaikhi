import { Router } from "express";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../middleware/auth.js";

const router = Router();

function authErrorResponse(res, err, context) {
  console.error(`[auth${context ? `/${context}` : ""}]`, err);
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return res.status(503).json({
      error:
        "Base de données inaccessible. Dans server/, lancez `npx prisma db push` puis `npm run db:seed`.",
    });
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return res.status(503).json({
      error:
        "Base de données inaccessible. Vérifiez DATABASE_URL dans server/.env et exécutez `npx prisma db push` dans le dossier server.",
    });
  }
  return res.status(500).json({
    error: "Erreur serveur. Consultez les logs du terminal API.",
  });
}

const registerSchema = z.object({
  email: z.string().email("Email invalide"),
  password: z.string().min(6, "Mot de passe : au moins 6 caractères"),
  name: z.string().max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { email, password, name } = parsed.data;
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: "Cet email est déjà utilisé" });
    }
    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hash, name: name ?? null },
      select: { id: true, email: true, name: true },
    });
    const token = signToken({ sub: user.id, email: user.email });
    res.status(201).json({ user, token });
  } catch (err) {
    authErrorResponse(res, err, "register");
  }
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Identifiants incorrects" });
    }
    const token = signToken({ sub: user.id, email: user.email });
    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      token,
    });
  } catch (err) {
    authErrorResponse(res, err, "login");
  }
});

export default router;
