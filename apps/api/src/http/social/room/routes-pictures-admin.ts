import type { RoomPictureApiDeps, RoomPicturesAdminResponse, SessionRecord } from '@prix/contracts';
import {
  ROOM_PICTURE_AUDIT_ACTIONS,
  ROOM_PICTURE_REPORTED_SHOWN,
  roomIdParamSchema,
  roomPictureReportHidesKey,
  roomPictureReportsKey,
} from '@prix/contracts';
import type { Hono } from 'hono';
import { failures, json, noContent } from '../../errors.ts';
import { assertFromSite, clientNetwork, enforceLimit } from '../../guard.ts';
import { matches } from '../../input.ts';
import { adminOr404, audit, dayOf } from '../shared.ts';
import { adminPicture, adminSet, fromOwnImage, servePicture } from './shared.ts';

/** The target of the audit line of the switch: it names no message. */
const SWITCH_TARGET = 'pictures';

/**
 * The admin's side of pictures: docs/contracts/phase-6-pictures.md sections 9 and 10. The list of reported
 * pictures, the admin's look at one, keep, and the switch that needs no deploy. Mounted whatever any
 * switch says: a reported picture is decided while pictures are off. Each route checks the session against
 * the admin wallets before it reads anything of the room, and answers anyone else exactly as an unknown
 * path. A removal is the room's own hide and mute (routes-admin.ts).
 *
 * The order of the three writes is the room's own: from the site; the admin's session; the id; the `write`
 * rule of the limiter for the admin's address; the store's write; the audit, only when the write changed
 * something. None passes `requireWriter`, on purpose, and no builder puts it back: a keep and the switch
 * must never fail because a budget of the day is spent.
 */
export function registerRoomPictureAdminRoutes(app: Hono, deps: RoomPictureApiDeps): void {
  const { pictures, bytes } = deps;
  const admins = adminSet(deps);

  /** The first steps of the switch's two writes: from the site, an admin's session, the limiter's `write` rule. */
  async function adminWriter(request: Request): Promise<SessionRecord> {
    assertFromSite(deps, request);
    const admin = await adminOr404(deps, request);
    await enforceLimit(deps, 'write', admin.address);
    return admin;
  }

  // Whether pictures are off and why, and the pictures that wait for a decision, oldest first, with the
  // whole addresses of the writer and of the wallets that reported each. Never cached, and never a key.
  app.get('/social/admin/room/pictures', async (c) => {
    await adminOr404(deps, c.req.raw);
    const now = deps.now().toISOString();
    // One more than is shown, to know whether there are more.
    const [off, rows] = await Promise.all([
      pictures.getPicturesOff(),
      pictures.listReported(ROOM_PICTURE_REPORTED_SHOWN + 1),
    ]);
    const reported: RoomPicturesAdminResponse['reported'] = [];
    for (const row of rows.slice(0, ROOM_PICTURE_REPORTED_SHOWN)) {
      if (row.picture === null) continue;
      reported.push({
        id: row.id,
        at: row.at,
        author: row.author,
        picture: adminPicture(row, row.picture, admins, now),
        reporters: row.reporters.map((reporter) => ({ address: reporter.address, at: reporter.at })),
      });
    }
    return json<RoomPicturesAdminResponse>(
      {
        off: off === null ? null : { at: off.at, by: off.by, why: off.why },
        reported,
        more: rows.length > ROOM_PICTURE_REPORTED_SHOWN,
      },
      200,
      'private',
    );
  });

  // The switch. Registered before the routes by an id; an id is digits, so the two never meet. With the
  // row set no picture is served, uploaded or reported, from that statement on and without a deploy.
  app.put('/social/admin/room/pictures/off', async (c) => {
    const admin = await adminWriter(c.req.raw);
    const set = await pictures.setPicturesOff(admin.address.toLowerCase(), 'admin', deps.now().toISOString());
    if (set) audit(admin, ROOM_PICTURE_AUDIT_ACTIONS.off, SWITCH_TARGET);
    return noContent();
  });

  // Switching pictures on gives the room its day's reports and its hour's hides again: the store deletes
  // the row and those two counters in one batch, the day and the hour of this route's `now`. With nothing
  // to switch it deletes nothing, and nothing is audited.
  app.delete('/social/admin/room/pictures/off', async (c) => {
    const admin = await adminWriter(c.req.raw);
    const at = deps.now();
    const day = dayOf(at.toISOString());
    const cleared = await pictures.clearPicturesOff(
      roomPictureReportsKey(day),
      roomPictureReportHidesKey(day, at.getUTCHours()),
    );
    if (cleared) audit(admin, ROOM_PICTURE_AUDIT_ACTIONS.on, SWITCH_TARGET);
    return noContent();
  });

  // The admin's look at a picture: an `<img>` on the admins' own page, and nothing else. It also serves a
  // reported picture, is not bound by the newest ids or by the switch, and is not counted as a view.
  app.get('/social/admin/room/pictures/:id', async (c) => {
    const request = c.req.raw;
    // A HEAD is the generic 404, always, and never runs the route: no page sends one.
    if (request.method !== 'GET') throw failures.routeNotFound();
    // Step 2 of section 7, as a hard rule, before the session is read.
    if (!fromOwnImage(request)) throw failures.routeNotFound();
    await adminOr404(deps, request);
    const param = c.req.param('id');
    if (!matches(roomIdParamSchema, param)) throw failures.routeNotFound();
    const id = Number(param);
    // The `picture` rule of the limiter, for the network the request comes from.
    if (!(await deps.pictureLimiter.allow(clientNetwork(request)))) throw failures.rateLimited(60);
    const picture = await pictures.getAdminPicture(id, deps.now().toISOString());
    // A picture whose writer is an admin wallet now is never served, to an admin either: it is removed
    // without looking.
    if (picture === null || admins.has(picture.author.toLowerCase())) throw failures.routeNotFound();
    return servePicture(bytes, id, picture);
  });

  // An admin keeps a picture: it is shown again and takes no more reports, and every wallet that reported
  // it gets a strike. 204 when it was kept now or before; only a keep that changed something is audited.
  app.put('/social/admin/room/pictures/:id/keep', async (c) => {
    const request = c.req.raw;
    assertFromSite(deps, request);
    const admin = await adminOr404(deps, request);
    const param = c.req.param('id');
    if (!matches(roomIdParamSchema, param)) throw failures.routeNotFound();
    await enforceLimit(deps, 'write', admin.address);
    const outcome = await pictures.keepPicture(Number(param), admin.address.toLowerCase(), deps.now().toISOString());
    if (outcome === 'none') throw failures.routeNotFound();
    if (outcome === 'kept') audit(admin, ROOM_PICTURE_AUDIT_ACTIONS.keep, param);
    return noContent();
  });
}
