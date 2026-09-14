import { Router } from "express";
import { listTools } from "../tools/index.js";

export const toolsRouter = Router();

toolsRouter.get("/tools", (_req, res) => {
  res.json(
    listTools().map((t) => ({
      name: t.name,
      description: t.description,
      category: t.category,
      parameters: t.parameters,
    })),
  );
});
