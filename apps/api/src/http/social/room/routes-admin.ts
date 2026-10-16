import type {
  RoomAdminWithPicturesResponse,
  RoomMessageRecord,
  RoomPictureApiDeps,
  SessionRecord,
} from '@prix/contracts';
import {
  ROOM_AUDIT_ACTIONS,
  ROOM_PAGE,
  ROOM_PICTURE_DELETES_PER_CALL,
  ROOM_PICTURE_LOG_EVENTS,
  roomAdminQuerySchema,
  roomIdParamSchema,
} from '@prix/contracts';
import type { Hono } from 'hono';
import { failures, json, noContent } from '../../errors.ts';
import { assertFromSite, enforceLimit } from '../../guard.ts';
import { matches, readQuery } from '../../input.ts';
import { adminOr404, audit } from '../shared.ts';
import { roomRefusal } from './refusals.ts';
import { adminMessage, adminPicture, adminSet, logPicture } from './shared.ts';

/**
 * The admin's read of the room and its three writes: docs/contracts/phase-6-room.md sections 7 and 8.
 * Mounted whatever the switch says. Each route checks the session against the admin wallets before it
 * reads anything of the room, and answers anyone else exactly as an unknown path.
 *
 * The three writes are by a message's id, so that no address travels in a path or in a log line. Their
 * order is section 7's at revision 5: from the site; the admin's session; the id and the message, by a
 * read; then the `write` rule of the limiter for the admin's address; then the store's write; then the
 * audit, only when the write changed something. An id with no message and the mute of an admin's message
 * cost the one read and never reach the limiter.
 *
 * None of the three passes `requireWriter`, on purpose, and no builder puts it back: a hide, a mute and a
 * lift are booked against no budget of the day, so that a message can still be taken down when the admin
 * wallet's writes of the day or the API's rows of the day are spent. What bounds an admin wallet here is
 * the limiter's rule per minute, the same count its own messages and every other write of it use.
 */
export function registerRoomAdminRoutes(app: Hono, deps: RoomPictureApiDeps): void {
  const { room, pictures, bytes } = deps;
  const admins = adminSet(deps);

  /**
   * The first three steps of every write: from the site; an admin's session, the generic 404 to anyone
   * else; the message the path names, by a read, the generic 404 when the id is not one or no message has
   * it. Nothing is counted here.
   */
  async function adminAndMessage(
    request: Request,
    id: string | undefined,
  ): Promise<{ admin: SessionRecord; message: RoomMessageRecord }> {
    assertFromSite(deps, request);
    const admin = await adminOr404(deps, request);
    if (!matches(roomIdParamSchema, id)) throw failures.routeNotFound();
    const message = await room.getMessage(Number(id));
    if (message === null) throw failures.routeNotFound();
    return { admin, message };
  }

  // Every message with its whole address, and the three things that keep one from the public: hidden,
  // its writer muted now, or written at or before its writer's cut. Never cached.
  app.get('/social/admin/room', async (c) => {
    await adminOr404(deps, c.req.raw);
    const { before } = readQuery(roomAdminQuerySchema, c.req.url);
    // One more than a page, to know whether there are older ones. From Phase 6.4 on each message comes
    // with its picture, whatever the switch of pictures says: an admin cleans a room that is switched off.
    const now = deps.now().toISOString();
    const rows = await pictures.listAllWithPictures(before === undefined ? null : Number(before), ROOM_PAGE + 1);
    const shown = rows.slice(0, ROOM_PAGE);
    const last = shown.at(-1);
    return json<RoomAdminWithPicturesResponse>(
      {
        messages: shown.map((message) => ({
          ...adminMessage(message, admins),
          picture: message.picture === null ? null : adminPicture(message, message.picture, admins, now),
        })),
        older: rows.length > ROOM_PAGE && last !== undefined ? last.id : null,
      },
      200,
      'private',
    );
  });

  // Hides a message for good: 204 when it hid it or it was hidden already. A picture message loses its
  // picture in the same batch (docs/contracts/phase-6-pictures.md section 9): from that statement on D1
  // refuses the picture, whatever KV then does. Only after it the bytes are deleted, and marked gone when
  // the delete has answered. A delete that throws changes nothing of the answer: the row keeps its key
  // and the sweep job tries again.
  app.delete('/social/admin/room/messages/:id', async (c) => {
    const { admin, message } = await adminAndMessage(c.req.raw, c.req.param('id'));
    await enforceLimit(deps, 'write', admin.address);
    const now = deps.now().toISOString();
    const hidden = await pictures.hideWithPicture(message.id, admin.address.toLowerCase(), now);
    // The prune job may have taken the message between the look and the write.
    if (hidden.outcome === 'none') throw failures.routeNotFound();
    // Audited when something changed: the message was hidden, or a picture was removed (a message that an
    // older API hid still had its picture). A removal's line carries the picture's count of reports.
    if (hidden.outcome === 'hidden' || hidden.removed) {
      audit(admin, ROOM_AUDIT_ACTIONS.hide, String(message.id), hidden.removed ? hidden.reports : undefined);
    }
    if (hidden.key !== null) {
      try {
        await bytes.delete(hidden.key);
        await pictures.markGone([message.id], now);
      } catch {
        logPicture(ROOM_PICTURE_LOG_EVENTS.deleteFailed, { id: message.id });
      }
    }
    return noContent();
  });

  // Mutes the writer of a message: it writes no more, and nothing it wrote at or before now is shown again.
  // Every picture of the writer is removed in the same batch, whether or not the writer was muted already;
  // then their bytes are deleted, one after another, and those that answered are marked gone in one call.
  // A delete that throws is logged and left to the sweep job. A mute writes no block row and its audit
  // line carries no count: it judges a writer, not a picture.
  app.put('/social/admin/room/messages/:id/mute', async (c) => {
    const { admin, message } = await adminAndMessage(c.req.raw, c.req.param('id'));
    const writer = message.author.toLowerCase();
    // An admin's writer cannot be muted. Refused before the limiter is asked.
    if (admins.has(writer)) return roomRefusal('admin');
    await enforceLimit(deps, 'write', admin.address);
    const now = deps.now().toISOString();
    const muted = await pictures.muteWithPictures(
      writer,
      admin.address.toLowerCase(),
      now,
      ROOM_PICTURE_DELETES_PER_CALL,
    );
    if (muted.muted || muted.removed > 0) audit(admin, ROOM_AUDIT_ACTIONS.mute, String(message.id));
    const gone: number[] = [];
    for (const picture of muted.pictures) {
      try {
        await bytes.delete(picture.key);
        gone.push(picture.id);
      } catch {
        logPicture(ROOM_PICTURE_LOG_EVENTS.deleteFailed, { id: picture.id });
      }
    }
    if (gone.length > 0) {
      try {
        await pictures.markGone(gone, now);
      } catch {
        // The deletes answered and their rows still name the keys: the sweep job deletes them once more.
        logPicture(ROOM_PICTURE_LOG_EVENTS.deleteFailed, { count: gone.length });
      }
    }
    return noContent();
  });

  // Lifts the mute of the writer of a message. The store moves the cut to the writer's newest message in
  // the same write, so nothing the writer wrote before the lift is shown, also a message that was stored
  // while the mute was on its way. Never refused for an admin's message: a wallet muted before it became
  // an admin is unmuted this way.
  app.delete('/social/admin/room/messages/:id/mute', async (c) => {
    const { admin, message } = await adminAndMessage(c.req.raw, c.req.param('id'));
    await enforceLimit(deps, 'write', admin.address);
    if (await room.unmuteWriter(message.author.toLowerCase())) {
      audit(admin, ROOM_AUDIT_ACTIONS.unmute, String(message.id));
    }
    return noContent();
  });
}
