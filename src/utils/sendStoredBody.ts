import consola from "consola";
import type { Response } from "express";
import type { Readable } from "stream";
import { pipeline } from "stream";

/** Streams a stored object into a response. A read error ends this response and is
    logged; with `pipe` it had no listener and took the whole process down. */
export function sendStoredBody(body: Readable, res: Response, what: string): void {
  pipeline(body, res, (err) => {
    if (!err) return;
    // The reader hanging up mid-file is routine, not a storage fault.
    if ((err as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") {
      consola.debug(`[storage] ${what}: client closed the download early`);
      return;
    }
    consola.warn(`[storage] ${what}: read failed partway through, response cut short`, err);
  });
}
