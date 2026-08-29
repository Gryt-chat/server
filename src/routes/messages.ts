import express from "express";
import type { Request, Response, NextFunction } from "express";
import { listMessages } from "../db";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { DENIAL_RESPONSES, resolveConversationAccess } from "../socket/utils/conversationAccess";

export const messagesRouter = express.Router();

messagesRouter.use(requireBearerToken);

messagesRouter.get(
  "/:conversationId",
  (req: Request, res: Response, next: NextFunction): void => {
    const { conversationId } = req.params as { conversationId: string };
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
    const before = req.query.before ? new Date(String(req.query.before)) : undefined;

    // The same rule the socket path uses, from the same file. A bearer token
    // says who is asking and that they are a member of this server; it does
    // not say this conversation is one they are party to, and this route is
    // the easy one to forget when that distinction starts to matter.
    Promise.resolve()
      .then(() => resolveConversationAccess(conversationId, req.tokenPayload?.serverUserId))
      .then((access) => {
        if (!access.allowed) {
          const { error, message, status } = DENIAL_RESPONSES[access.reason];
          res.status(status).json({ error, message });
          return undefined;
        }
        return listMessages(conversationId, limit, before).then((messages) => {
          res.json({ items: messages });
        });
      })
      .catch(next);
  },
);
