import express from "express";
import type { Request, Response, NextFunction } from "express";
import { getAllRegisteredUsers } from "../db/scylla";
import { requireBearerToken } from "../middleware/requireBearerToken";

export const membersRouter = express.Router();

membersRouter.use(requireBearerToken);

membersRouter.get(
  "/",
  (_req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(() => getAllRegisteredUsers())
      .then((users) => {
        const members = users
          .filter((u) => u.is_active)
          .map((user) => ({
            serverUserId: user.server_user_id,
            nickname: user.nickname,
            lastSeen: user.last_seen,
          }));
        res.json({ items: members });
      })
      .catch(next);
  },
);
