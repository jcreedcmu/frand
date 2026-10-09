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
 * Total attenuation across the falloff band, in decibels. The curve is an
 * exponential decay, so the drop per unit distance is constant in decibels,
 * which is how a fade is heard as even: an amplitude curve that looks gentle
 * is mostly inaudible for much of its range and then collapses at the end.
 *
 * Lower this if voices become too quiet too early; it is the one number that
 * governs how much of the sense of distance comes from volume rather than
 * from the filter and the reverb.
 */
export const GAIN_DROP_DB = 24;

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

/**
 * Share of a distant voice routed through the reverb bus instead of straight
 * to the output. The ratio of direct to reverberant sound is the cue this is
 * after, so some direct signal is always kept: at 1 a far voice would be all
 * tail and unintelligible.
 */
export const WET_MAX = 0.7;

/**
 * Tail length in seconds and the exponent shaping its decay. Together they
 * set how long the room rings: the tail reaches silence at roughly
 * `REVERB_SECONDS` and spends most of its energy earlier the higher
 * `REVERB_DECAY` is. These are the numbers to raise for a bigger space.
 */
export const REVERB_SECONDS = 0.55;
export const REVERB_DECAY = 1.8;

/**
 * Gap before the tail starts, which is the time a first reflection takes to
 * come back and so reads directly as the distance to the nearest wall.
 * Without any of it the reverb smears into the voice instead of sounding
 * like a room around it; too much of it puts the walls far away.
 */
export const REVERB_PREDELAY = 0.008;

/** Low-pass applied to the tail itself, leaving it darker than the direct
 *  sound. Small rooms are brighter than large ones. */
export const REVERB_TONE_HZ = 4500;

/** Trim for the whole reverb bus, applied after the convolver normalises. */
export const REVERB_LEVEL = 0.9;
