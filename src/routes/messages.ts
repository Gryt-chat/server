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

    // A bearer token says they are a member, not that this conversation is one
    // of theirs. Same rule as the socket path, from the same file.
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
