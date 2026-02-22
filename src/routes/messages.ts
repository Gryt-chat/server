import express from "express";
import type { Request, Response, NextFunction } from "express";
import { listMessages } from "../db/scylla";
import { requireBearerToken } from "../middleware/requireBearerToken";

export const messagesRouter = express.Router();

messagesRouter.use(requireBearerToken as any);

messagesRouter.get(
  "/:conversationId",
  (req: Request, res: Response, next: NextFunction): void => {
    const { conversationId } = req.params as { conversationId: string };
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
    const before = req.query.before ? new Date(String(req.query.before)) : undefined;
    Promise.resolve()
      .then(() => listMessages(conversationId, limit, before))
      .then((messages) => res.json({ items: messages }))
      .catch(next);
  },
);
