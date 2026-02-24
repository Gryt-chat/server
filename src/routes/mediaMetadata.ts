import { Router } from "express";

import { requireBearerToken } from "../middleware/requireBearerToken";
import { fetchRemoteImageMetadata } from "../utils/remoteImageMetadata";

const router = Router();

router.get("/", requireBearerToken, async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!url) {
    res.status(400).json({ error: "missing_url", message: "URL parameter is required" });
    return;
  }

  const meta = await fetchRemoteImageMetadata(url);
  res.json(meta);
});

export const mediaMetadataRouter = router;

