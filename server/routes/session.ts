import { Router } from "express";

export const sessionRouter = Router();

sessionRouter.get("/session", (req, res) => {
  // The session id is deliberately absent. It used to be returned here, and it
  // is the exact value of the httpOnly `sid` cookie — which means any script
  // that ran on the page could read back the one thing httpOnly exists to hide
  // and send it somewhere else. Nothing in the client ever used it.
  res.json({ createdAt: req.sessionCreatedAt });
});
