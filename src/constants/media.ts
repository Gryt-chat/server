/**
 * Avatar sizes. The image worker needs the thumbnail size and shares no package
 * with this one, so the server records it in `server_config.avatar_thumb_px` on
 * every start and the worker reads that.
 */

/**
 * The largest an avatar is stored at. Nothing displays one bigger — the voice
 * tile is the most demanding at ~96 CSS px, which is 192 device px on a 2x
 * screen — so anything above this is bytes nobody looks at.
 */
export const AVATAR_MAX_PX = 256;

/**
 * The avatar thumbnail's size.
 *
 * 128 rather than 64 because of where it gets used. The small avatar sites
 * render at 28–46 CSS px, which is 56–92 device px on a 2x screen, and a 64px
 * source is soft at the top of that range — so the thumbnail existed but was
 * not usable for most of the places that wanted it.
 */
export const AVATAR_THUMB_PX = 128;
