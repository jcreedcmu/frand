/** World dimensions, kept in step with the same constants in the server. */
export const WORLD_W = 1600;
export const WORLD_H = 900;

/** Closer than this and a player is at full volume. */
export const FULL_GAIN_RADIUS = 250;

/**
 * Further than this and a player is silent. A full lobby is 15 simultaneous
 * voices, so radii that feel right with four people will be too generous with
 * sixteen: this is the pair of numbers to turn.
 */
export const SILENCE_RADIUS = 900;

/**
 * Shapes the volume falloff between the two radii. 1 is linear; higher values
 * hold a voice near full volume across most of the range and drop it only
 * near the silence radius, which leaves the filter to carry the sense of
 * distance.
 */
export const GAIN_FALLOFF = 2;

/**
 * The low-pass cutoff spans the whole distance from zero to
 * `SILENCE_RADIUS`, not just the falloff band, so distance is audible as
 * muffling well before it is audible as quiet. Both ends are low enough to
 * sit inside the range speech actually occupies.
 */
export const NEAR_CUTOFF_HZ = 10000;
export const FAR_CUTOFF_HZ = 300;

/** Hard left and hard right are reserved, so a voice never collapses into
 *  one ear entirely. */
export const PAN_WIDTH = 0.85;
