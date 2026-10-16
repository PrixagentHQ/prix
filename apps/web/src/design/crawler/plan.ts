/**
 * Where the crawler goes, as pure functions of the map and the pointer (docs/DESIGN.md section
 * 30). It stands, taps and reads only where its whole resting pose lies on free ground inside the
 * window; it walks only where its body has room off every wall. Every distance is a share of the
 * leg span, so a crawler of 260 pixels keeps about 220 from the pointer and reads a row from up to
 * 260 pixels off its edge.
 */
import { type BodyPlan, createCrawler, type Glyph, glyphs, type Vec } from './model.ts';
import { type Box, CELL, roomNeeded, type Space } from './space.ts';

/** About how far it keeps from the pointer, and how close it comes to tap a resting one. */
export const keep = (plan: BodyPlan) => plan.span * 0.85;
export const close = (plan: BodyPlan) => plan.span * 0.42;
/** How far from a row's edge it looks for a place to read from. */
export const readReach = (plan: BodyPlan) => plan.span;
/** A press this close to the body sends it off, 1 to 1.6 spans away. */
export const scare = (plan: BodyPlan) => plan.span;
const SCURRY = [1.25, 1, 1.6, 1.12, 1.4];
/** The most poses one search for a place to stand checks (each is some 200 glyph boxes). */
const TRIES = 60;
const SWING = [0, 0.45, -0.45, 0.9, -0.9, 1.35, -1.35];

/** The resting pose at a point, facing a heading. */
export function pose(plan: BodyPlan, at: Vec, heading: number): Glyph[] {
  return glyphs(createCrawler(plan, at.x, at.y, heading));
}

/** Whether the crawler can stand here, facing there: its whole resting pose on free ground in the window. */
export function canStand(space: Space, plan: BodyPlan, at: Vec, heading: number): boolean {
  return space.fits(pose(plan, at, heading), true);
}

/** The room the crawler's body needs to walk. */
export function walkRoom(plan: BodyPlan): number {
  return roomNeeded(plan.reach * 0.82, plan.font);
}

const facing = (from: Vec, to: Vec) => Math.atan2(to.y - from.y, to.x - from.x);

/**
 * The places it can stand nearest to `target`, nearest first, at most `count`, no two closer than
 * a body apart, within `within` pixels. `face` gives the heading it would stand at.
 */
export function standsNear(
  space: Space,
  plan: BodyPlan,
  target: Vec,
  face: (at: Vec) => number,
  within: number,
  count = 4,
  accept: (at: Vec) => boolean = () => true,
): Vec[] {
  const found: Vec[] = [];
  const quick = plan.reach * 0.5;
  const c0 = Math.floor((target.x - space.x0) / CELL);
  const r0 = Math.floor((target.y - space.y0) / CELL);
  const rings = Math.ceil(within / CELL);
  // A pose check costs a pose: at most TRIES of them a search, nearest first.
  let tries = TRIES;
  for (let ring = 0; ring <= rings && found.length < count && tries > 0; ring += 1) {
    const here: Vec[] = [];
    for (let dr = -ring; dr <= ring; dr += 1) {
      for (let dc = -ring; dc <= ring; dc += 1) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const at = { x: space.x0 + (c0 + dc + 0.5) * CELL, y: space.y0 + (r0 + dr + 0.5) * CELL };
        if (Math.hypot(at.x - target.x, at.y - target.y) > within || !accept(at)) continue;
        if (space.roomAt(at.x, at.y) < quick) continue;
        if (found.some((p) => Math.hypot(p.x - at.x, p.y - at.y) < plan.reach)) continue;
        if (tries <= 0) break;
        tries -= 1;
        if (canStand(space, plan, at, face(at))) here.push(at);
      }
    }
    here.sort((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y));
    for (const at of here) {
      if (found.length < count && !found.some((p) => Math.hypot(p.x - at.x, p.y - at.y) < plan.reach)) found.push(at);
    }
  }
  return found;
}

/** A walk to the first of `stands` it can reach from `from`, or null. */
export function walkTo(space: Space, plan: BodyPlan, from: Vec, stands: Vec[]): Vec[] | null {
  const need = walkRoom(plan);
  for (const at of stands) {
    const route = space.route(from, at, need);
    const end = route?.[route.length - 1];
    if (route && end && end.x === at.x && end.y === at.y) return route;
  }
  return null;
}

/** Following: a place about `keep` from the pointer, on its side of it, facing the pointer. */
export function followStand(space: Space, plan: BodyPlan, body: Vec, pointer: Vec): Vec[] {
  const away = facing(pointer, body);
  const want = { x: pointer.x + Math.cos(away) * keep(plan), y: pointer.y + Math.sin(away) * keep(plan) };
  return standsNear(space, plan, want, (at) => facing(at, pointer), plan.span * 1.4);
}

/** Tapping a resting pointer: a place about `close` from it, the spot inside the front legs' reach. */
export function restStand(space: Space, plan: BodyPlan, body: Vec, pointer: Vec): Vec[] {
  const away = facing(pointer, body);
  const want = { x: pointer.x + Math.cos(away) * close(plan), y: pointer.y + Math.sin(away) * close(plan) };
  const reach = plan.thigh + plan.shin + Math.hypot(plan.hips[0]?.x ?? 0, plan.hips[0]?.y ?? 0) - 2;
  return standsNear(space, plan, want, (at) => facing(at, pointer), plan.span * 0.25).filter(
    (at) => Math.hypot(at.x - pointer.x, at.y - pointer.y) <= reach,
  );
}

/** The nearest point of a segment to a point. */
function onSegment(a: Vec, b: Vec, p: Vec): Vec {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

export interface ReadPlan {
  at: Vec;
  /** The stretch of the row's edge its front feet run along, just outside the row. */
  a: Vec;
  b: Vec;
  heading: number;
}

/**
 * Reading a row: the place nearest to the row's left or right edge, within `readReach` of it,
 * facing the edge; its front feet run along the part of the edge they reach, a pixel outside the
 * row. None when no place lies that near: then it only turns toward the row.
 */
export function readStand(space: Space, plan: BodyPlan, row: Box): ReadPlan[] {
  const out: ReadPlan[] = [];
  const reach = plan.thigh + plan.shin;
  const within = readReach(plan);
  for (const side of [-1, 1]) {
    const x = side < 0 ? row.x - 1 : row.x + row.w + 1;
    const a = { x, y: row.y + 3 };
    const b = { x, y: row.y + row.h - 3 };
    const middle = { x, y: row.y + row.h / 2 };
    // Its front feet rest just short of the edge, so they reach it to read and step back off it.
    const front = (plan.rests[0]?.x ?? 0) + 0.3 * plan.font + 2;
    // A place is judged before it is taken, so one that cannot read never hides a nearer one that can.
    const near = standsNear(
      space,
      plan,
      { x: x + side * front, y: middle.y },
      (at) => facing(at, onSegment(a, b, at)),
      within,
      3,
      (at) =>
        (side < 0 ? at.x < row.x : at.x > row.x + row.w) &&
        Math.abs(at.x - x) >= front &&
        Math.hypot(at.x - onSegment(a, b, at).x, at.y - onSegment(a, b, at).y) <= within,
    );
    for (const at of near) {
      const touch = onSegment(a, b, at);
      // The feet run along the part of the edge within reach, at most the row's height.
      const span = Math.min(
        (b.y - a.y) / 2,
        Math.max(4, Math.sqrt(Math.max(0, reach * reach - (touch.x - at.x) ** 2)) * 0.6),
      );
      const ya = Math.max(a.y, touch.y - span);
      const yb = Math.min(b.y, touch.y + span);
      out.push({ at, a: { x, y: ya }, b: { x, y: yb }, heading: facing(at, touch) });
    }
  }
  const distance = (r: ReadPlan) => Math.hypot(r.at.x - r.a.x, r.at.y - (r.a.y + r.b.y) / 2);
  return out.sort((p, q) => distance(p) - distance(q));
}

/** Scurrying from a press: places 1 to 1.6 spans away, away from the press, in a fixed order. */
export function scurryStands(space: Space, plan: BodyPlan, body: Vec, press: Vec): Vec[] {
  const away = facing(press, body);
  const out: Vec[] = [];
  for (const swing of SWING) {
    for (const share of SCURRY) {
      const distance = share * plan.span;
      const at = {
        x: body.x + Math.cos(away + swing) * distance,
        y: body.y + Math.sin(away + swing) * distance,
      };
      const heading = facing(press, at);
      if (canStand(space, plan, at, heading)) out.push(at);
      if (out.length >= 4) return out;
    }
  }
  return out;
}

/** Just outside the window's left or right edge, at a height: where it comes in and goes out. */
export function offside(space: Space, plan: BodyPlan, side: -1 | 1, y: number): Vec {
  const v = space.view;
  const x = side < 0 ? v.x - plan.reach - 12 : v.x + v.w + plan.reach + 12;
  return { x, y };
}

/** The window's side edge nearest a point. */
export function nearestSide(space: Space, p: Vec): -1 | 1 {
  return p.x - space.view.x < space.view.x + space.view.w - p.x ? -1 : 1;
}
