/** The image worker shares no package with this one, so the server records the
    thumbnail size in `server_config.avatar_thumb_px` on every start. */

/** The voice tile is the most demanding at ~96 CSS px, or 192 device px on a
    2x screen, so anything above this is bytes nobody looks at. */
export const AVATAR_MAX_PX = 256;

/** 128 rather than 64: the small avatar sites render at 56-92 device px on a 2x
    screen, and a 64px source is soft at the top of that. */
export const AVATAR_THUMB_PX = 128;

/** The member card's banner is 320 by 164 CSS px, so 3x of that. Any other shape and the card
    crops and scales the stored picture again, so it stops matching what the editor showed. */
export const BANNER_BOX = { width: 960, height: 492, thumbWidth: 480, thumbHeight: 246 } as const;
