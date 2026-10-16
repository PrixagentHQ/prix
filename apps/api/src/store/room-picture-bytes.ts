import type { RoomPictureBytes } from '@prix/contracts';
import { ROOM_PICTURES_KV_BINDING, roomPictureKeySchema } from '@prix/contracts';

/**
 * The bytes of the room's pictures, over the KV namespace bound as ROOM_PICTURES
 * (docs/contracts/phase-6-pictures.md section 6). KV holds bytes and decides nothing: D1 says whether a
 * picture may be shown, and a caller comes here only after a method of `RoomPictureStore` has answered
 * the key.
 *
 * The port is three methods and no more. It has no list, no metadata and no put without an expiry, so
 * that no builder can reach for one: the expiry of every put is what bounds the storage, removes a key no
 * row names without a list call, and makes a failed delete harmless.
 *
 * With no binding every method throws. The namespace is the founder's to create, after the build, and
 * until then each caller does what it does when KV fails: the upload answers `picture_storage`, a bytes
 * route its 503, a hide and a mute still answer 204 and leave the delete owed, the sweep fails its run.
 * Nothing is skipped in silence.
 *
 * Its tests: apps/api/src/store/room-pictures.d1.test.ts, against a KV that writes down every call.
 */

/** The part of a KV namespace this file uses. `KVNamespace` of the Workers runtime fits it. */
export interface RoomPictureKv {
  put(key: string, value: ArrayBuffer, options: { expirationTtl: number }): Promise<void>;
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

/** KV's own floor for `expirationTtl`, in seconds (Cloudflare: "The minimum value is 60."). */
const KV_MIN_TTL_SECONDS = 60;

/** An ArrayBuffer of exactly these bytes: a view into a larger buffer is copied out, never stored whole. */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) return buffer;
  const copy = new Uint8Array(byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * A key is `pic/` and 32 hex characters, made by the server for every upload. Anything else is a bug of
 * the caller and is refused here, before KV is asked: this namespace holds nothing but pictures.
 */
function assertKey(key: string): void {
  if (!roomPictureKeySchema.safeParse(key).success) throw new Error("room pictures: not a picture's key");
}

export function createRoomPictureBytes(kv: RoomPictureKv | undefined): RoomPictureBytes {
  function bound(): RoomPictureKv {
    if (kv === undefined || kv === null) {
      throw new Error(`room pictures: the KV binding ${ROOM_PICTURES_KV_BINDING} is missing`);
    }
    return kv;
  }

  return {
    async put(key, bytes, ttlSeconds) {
      const namespace = bound();
      assertKey(key);
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < KV_MIN_TTL_SECONDS) {
        throw new Error('room pictures: a put carries an expiry in whole seconds, 60 at least');
      }
      await namespace.put(key, exactBuffer(bytes), { expirationTtl: ttlSeconds });
    },

    async get(key) {
      const namespace = bound();
      assertKey(key);
      const value = await namespace.get(key, 'arrayBuffer');
      return value === null ? null : new Uint8Array(value);
    },

    async delete(key) {
      const namespace = bound();
      assertKey(key);
      await namespace.delete(key);
    },
  };
}
