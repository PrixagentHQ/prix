import {
  ROOM_PICTURE_UPLOAD_CONTENT_TYPE,
  ROOM_PICTURES_ADMIN_PATH,
  ROOM_PICTURES_PATH,
  roomPictureReportPath,
} from '@prix/contracts/room-picture';
import type { Answer } from './answers.ts';

/**
 * The calls the scripts of the Community chat make (docs/contracts/phase-6-room.md section 8 and
 * docs/contracts/phase-6-pictures.md section 10), from the site's own origin with the session's cookie:
 * `me`, the send of a line, the send of a picture, a report, and the admins' writes. Each asks a wallet
 * for nothing. The API decides every one of them, and checks the admin again on each.
 *
 * A call never throws and is made once: nothing here tries again, and nothing here waits. It resolves
 * to the status and the parsed body, or to status 0 when there was no answer. Under __PRIX_FIXTURES__
 * the same calls answer from ./fixtures.ts, by the names `?fixture=` carries on the page's address.
 */

export interface RoomCall {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /** A picture's file, sent as it is: the body of the upload is the file's bytes and nothing else. */
  bytes?: Blob;
}

const ROOM = '/api/social/room';
const ADMIN = '/api/social/admin/room/messages';
/** A message's id as the contract's `roomIdParamSchema` takes it: digits with no leading zero. */
const ID = /^[1-9]\d{0,14}$/;

async function overHttp(call: RoomCall): Promise<Answer> {
  // The API takes a request that changes state only as JSON, with or without a body.
  const headers: Record<string, string> = { accept: 'application/json' };
  if (call.method !== 'GET') headers['content-type'] = 'application/json';
  // But for a picture: its bytes, with exactly the type the contract names. No form, no file name.
  if (call.bytes !== undefined) headers['content-type'] = ROOM_PICTURE_UPLOAD_CONTENT_TYPE;
  const response = await fetch(call.path, {
    method: call.method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
    body: call.bytes ?? (call.body === undefined ? undefined : JSON.stringify(call.body)),
  });
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, body };
}

async function send(call: RoomCall): Promise<Answer> {
  try {
    if (typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__) {
      const { roomFixtureAnswer } = await import('./fixtures.ts');
      return roomFixtureAnswer(new URL(window.location.href).searchParams.get('fixture'), call);
    }
    return await overHttp(call);
  } catch {
    return { status: 0, body: null };
  }
}

/** A call by a message's id. An id that is no id is answered here as the API's generic 404. */
function byId(method: RoomCall['method'], id: string, path: (id: string) => string): Promise<Answer> {
  if (!ID.test(id)) return Promise.resolve({ status: 404, body: null });
  return send({ method, path: path(id) });
}

/** GET /api/social/room/me: whether this wallet may write, and what is left of its day. */
export const readMe = (): Promise<Answer> => send({ method: 'GET', path: `${ROOM}/me` });

/** POST /api/social/room. The server folds the line, judges it and decides. */
export const postLine = (line: string): Promise<Answer> => send({ method: 'POST', path: ROOM, body: { text: line } });

/** POST /api/social/room/pictures. The server runs the picture rule on whatever arrives and stores only its answer. */
export const postPicture = (bytes: Blob): Promise<Answer> => send({ method: 'POST', path: ROOM_PICTURES_PATH, bytes });

/** POST /api/social/room/pictures/:id/report: no body and no words. The answer never says what was counted. */
export const reportPicture = (id: number): Promise<Answer> => send({ method: 'POST', path: roomPictureReportPath(id) });

/** DELETE /api/social/admin/room/messages/:id. For a picture message it removes the picture and deletes its file. */
export const hideMessage = (id: string): Promise<Answer> => byId('DELETE', id, (of) => `${ADMIN}/${of}`);
/** PUT /api/social/admin/room/messages/:id/mute */
export const muteWriter = (id: string): Promise<Answer> => byId('PUT', id, (of) => `${ADMIN}/${of}/mute`);
/** DELETE /api/social/admin/room/messages/:id/mute */
export const unmuteWriter = (id: string): Promise<Answer> => byId('DELETE', id, (of) => `${ADMIN}/${of}/mute`);
/** PUT /api/social/admin/room/pictures/:id/keep */
export const keepPicture = (id: string): Promise<Answer> =>
  byId('PUT', id, (of) => `${ROOM_PICTURES_ADMIN_PATH}/${of}/keep`);
/** PUT /api/social/admin/room/pictures/off: no picture is served, added or reported from that write on. */
export const picturesOff = (): Promise<Answer> => send({ method: 'PUT', path: `${ROOM_PICTURES_ADMIN_PATH}/off` });
/** DELETE /api/social/admin/room/pictures/off */
export const picturesOn = (): Promise<Answer> => send({ method: 'DELETE', path: `${ROOM_PICTURES_ADMIN_PATH}/off` });
