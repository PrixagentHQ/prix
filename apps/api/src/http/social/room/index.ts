import type { RoomHoldersApiDeps, RoomPictureApiDeps } from '@prix/contracts';
import { Hono } from 'hono';
import { registerRoomAdminRoutes } from './routes-admin.ts';
import { registerRoomPictureRoutes } from './routes-pictures.ts';
import { registerRoomPictureAdminRoutes } from './routes-pictures-admin.ts';
import { registerRoomRoutes } from './routes-room.ts';

/**
 * Phase 6.3, the room: a public chat between users (docs/contracts/phase-6-room.md), and Phase 6.4, the
 * pictures in it (docs/contracts/phase-6-pictures.md). Every path is under `/social`, with the `/api`
 * prefix removed as in the other route files, on the same router as Phase 1, so the guard, the `read`
 * rule and the error handler apply.
 *
 * The public words are "Community chat" and "picture"; `room`, `pictures` and `pic` are the names in code,
 * tables and routes. From Phase 6.4 on all four factories take `RoomPictureApiDeps`: the room's read and
 * `me` carry pictures while `picturesEnabled` holds, and the admin's hide and mute delete a picture's
 * bytes whatever the switch says.
 *
 * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2): the read, `me`, the write and the upload take
 * `RoomHoldersApiDeps`: the Holder mark and the wallet's cap of the day by tier while `roomHoldersOn` and
 * `holdersGate` are given; absent counts as off.
 */

/**
 * The status, the read, `me` and the write. While the room is off this has no route at all, whoever
 * mounts it: every one of its paths is then the generic 404.
 */
export function createRoomRoutes(deps: RoomHoldersApiDeps): Hono {
  const routes = new Hono();
  if (deps.roomEnabled) registerRoomRoutes(routes, deps);
  return routes;
}

/**
 * The admin's read and its three writes, mounted whatever the switch says, so that a room that was
 * switched off can still be cleaned. Anyone who is not an admin session gets the generic 404.
 */
export function createRoomAdminRoutes(deps: RoomPictureApiDeps): Hono {
  const routes = new Hono();
  registerRoomAdminRoutes(routes, deps);
  return routes;
}

/**
 * The upload of a picture, its bytes and the report. While pictures are not enabled (SOCIAL_ENABLED,
 * ROOM_ENABLED and ROOM_PICTURES_ENABLED) this has no route at all, whoever mounts it: each of the three
 * paths is then the generic 404.
 */
export function createRoomPictureRoutes(deps: RoomHoldersApiDeps): Hono {
  const routes = new Hono();
  if (deps.picturesEnabled) registerRoomPictureRoutes(routes, deps);
  return routes;
}

/**
 * The admin's look at a picture, the list of reported pictures, keep, and the switch that needs no deploy.
 * Mounted whatever any switch says: a reported picture is decided while pictures are off. Anyone who is
 * not an admin session gets the generic 404.
 */
export function createRoomPictureAdminRoutes(deps: RoomPictureApiDeps): Hono {
  const routes = new Hono();
  registerRoomPictureAdminRoutes(routes, deps);
  return routes;
}
