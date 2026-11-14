import type { ReleaseCheck } from "@ember/protocol";

/** A release or a beta of Papaya OS as the Worker names it, with its notes and whether it's newer than this one. */
export type NamedRelease = NonNullable<ReleaseCheck["newest"]>;

/**
 * What Update Papaya OS would bring this Papaya OS now, which the rail's Admin marks: the newest release once it's
 * newer, or for a beta, the beta after it, as a copy on a beta is brought the betas after it until its
 * release is out (docs/self-hosting.md#betas).
 */
export function updateOf({ beta, newest, newestBeta }: ReleaseCheck): NamedRelease | null {
  if (newest?.newer) return newest;
  return beta && newestBeta?.newer ? newestBeta : null;
}

/** The beta a release is offered to try, once it has nothing newer to update to, which it takes only if asked. */
export function betaToTryOf(check: ReleaseCheck): NamedRelease | null {
  return !check.beta && !updateOf(check) && check.newestBeta?.newer ? check.newestBeta : null;
}
