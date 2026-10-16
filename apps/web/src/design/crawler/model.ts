/**
 * The crawler's body, as a pure model (docs/DESIGN.md section 30). No DOM, no Math.random, no
 * Date: the same inputs give the same crawler on every machine, so tests and recordings repeat.
 *
 * Time comes in from outside (a requestAnimationFrame timestamp or performance.now) and is spent
 * in fixed sub-steps of 1/240 s, so the crawler walks the same path at 60 Hz, 120 Hz or any rate,
 * and a frame longer than 50 ms counts as 50 ms.
 *
 * The body is a point with a heading, drawn in two parts: a small head in front and a larger
 * abdomen behind it. Eight legs, four a side, all from the head, each two bones: a long thigh from
 * a hip fixed to the body, a knee found by the law of cosines and bent outward (away from the
 * body's axis: the arch of a spider's leg seen from above), and a shorter shin to a foot planted
 * in the world. The legs walk in an alternating tetrapod (R1 R3 L2 L4 against R2 R4 L1 L3): a
 * planted foot of the group whose turn it is steps when it lies farther than the stride from where
 * it should be, in a short step with a small lift; the other group waits. Common techniques,
 * written here from first principles; nothing is taken from anyone's code.
 *
 * Everything is sized from the leg span, which the page fixes once per load from the window's
 * width (spanFor): 260 pixels from 1600, 200 from 1280, 160 from 1100.
 */

export interface Vec {
  x: number;
  y: number;
}

export interface BodyPlan {
  /** The leg span, in pixels: what every other length here is scaled from. */
  span: number;
  /** The size of its glyphs, in pixels of "Prix ASCII". */
  font: number;
  /** The eight hips in body space (x forward, y to the right): R1 to R4, then L1 to L4. */
  hips: Vec[];
  /** Where each foot rests, in body space. */
  rests: Vec[];
  thigh: number;
  shin: number;
  /** A planted foot farther than this from where it should be takes a step, in pixels. */
  stride: number;
  /** One step, in milliseconds at walking pace. */
  step: number;
  /** How far a lifted foot moves out from the body at the top of its step, in pixels. */
  lift: number;
  /** Walking speed, pixels a second, and how fast it turns (radians a second) and gathers speed. */
  speed: number;
  turn: number;
  accel: number;
  /** The body's glyphs, in body space: the head in front, the abdomen behind it. */
  body: { x: number; y: number; ch: string }[];
  /** The farthest any glyph centre lies from the body's centre in the resting pose, plus the stride. */
  reach: number;
}

/** A leg: its foot in the world, and the step it is taking (t is -1 when the foot is planted). */
export interface Leg {
  foot: Vec;
  from: Vec;
  to: Vec;
  t: number;
}

/** What the front legs do instead of walking: tap a spot, or run along the edge of a row. */
export type Gesture = { kind: 'tap'; at: number; spot: Vec } | { kind: 'read'; at: number; a: Vec; b: Vec };

export interface Crawler {
  plan: BodyPlan;
  x: number;
  y: number;
  heading: number;
  speed: number;
  legs: Leg[];
  /** The tetrapod whose turn it is to step: 0 is R1 R3 L2 L4, 1 is R2 R4 L1 L3. */
  group: number;
  /** The points to walk through; the last is where it stops. */
  route: Vec[];
  /** The heading to turn to once it stands. */
  face: number | null;
  /** 1 walking; about 3 when it scurries. */
  pace: number;
  gesture: Gesture | null;
  /** Simulated time in milliseconds, and what is left of the last frame below one sub-step. */
  time: number;
  carry: number;
}

export interface Glyph {
  x: number;
  y: number;
  ch: string;
  /** The body: drawn heavier, in the body's ink. */
  heavy: boolean;
  /** Its size in pixels of "Prix ASCII". */
  size: number;
}

/** The ramp of the field of characters (ground/field.ts). */
export const RAMP = ' .:-=+*#%@';
/** What the crawler draws with: the ramp, the strokes of ASCII line art, and ( ) o. Nothing else. */
export const INKS = `${RAMP}/\\|_()o`;
/** One sub-step, in milliseconds. */
export const TICK = 1000 / 240;
/** The longest frame the model takes in: a stall never throws the crawler across the page. */
export const MAX_FRAME = 50;
/** The field's cell: the face's advance at 12 pixels by the field's line of 14 (ground/field.ts, CELL). */
export const GLYPH = { w: 7.2, h: 14 } as const;
/** The front legs: R1 and L1. */
export const FRONT = [0, 4] as const;
/** The span of the model's own unit: every length below is given at this span and scaled. */
export const UNIT = 120;

const GROUP = [0, 1, 0, 1, 1, 0, 1, 0];
/** Each leg's foot at rest: its angle from straight ahead (degrees) and its distance from the hip. */
const ANGLES = [22, 54, 126, 158];
const LENGTHS = [58, 62, 62, 58];
/** The hips along the head, front to back. */
const HIPS = [7, 4, 1, -2];
/** The head and the abdomen, as ellipses: centre on the axis, half length, half width. */
const HEAD = { x: 4, rx: 4, ry: 5 };
const ABDOMEN = { x: -8.5, rx: 6.5, ry: 7.8 };
const TAP_MS = 280;
export const TAPS = 2;
export const READ_MS = 1200;

/** The leg span for a window this wide, fixed once per page load. */
export function spanFor(width: number): number {
  if (width >= 1600) return 260;
  if (width >= 1280) return 200;
  return 160;
}

/** The box of a glyph's cell: the face's advance (0.6 em) by a line of 1.15 em, centred on the glyph. */
export function glyphSize(font: number): { w: number; h: number } {
  return { w: 0.6 * font, h: 1.15 * font };
}

/** Dense glyphs filling an ellipse, on a lattice a little tighter than the face's advance. */
function blob(cx: number, rx: number, ry: number, font: number): { x: number; y: number; ch: string }[] {
  const out: { x: number; y: number; ch: string }[] = [];
  const sx = 0.42 * font;
  const sy = 0.4 * font;
  const ax = Math.max(0, rx - 0.25 * font);
  const ay = Math.max(0, ry - 0.25 * font);
  const nx = Math.floor(ax / sx);
  const ny = Math.floor(ay / sy);
  for (let j = -ny; j <= ny; j += 1) {
    for (let i = -nx; i <= nx; i += 1) {
      const r = (ax ? (i * sx) / ax : 0) ** 2 + (ay ? (j * sy) / ay : 0) ** 2;
      if (r <= 1) out.push({ x: cx + i * sx, y: j * sy, ch: r < 0.45 ? '@' : '#' });
    }
  }
  return out;
}

/** The body plan for a leg span: 260 pixels at the widest windows, a body of about 48 by 34. */
export function bodyPlan(span = UNIT): BodyPlan {
  const scale = span / UNIT;
  const font = Math.round((10 + 2.75 * scale) * 10) / 10;
  const hips: Vec[] = [];
  const rests: Vec[] = [];
  for (const side of [1, -1]) {
    for (let i = 0; i < 4; i += 1) {
      const hip = { x: (HIPS[i] ?? 0) * scale, y: 4.5 * side * scale };
      const angle = ((ANGLES[i] ?? 90) * Math.PI) / 180;
      const length = (LENGTHS[i] ?? 60) * scale;
      hips.push(hip);
      rests.push({ x: hip.x + Math.cos(angle) * length, y: hip.y + Math.sin(angle) * length * side });
    }
  }
  const stride = 12 * scale;
  const body = [
    ...blob(HEAD.x * scale, HEAD.rx * scale, HEAD.ry * scale, font),
    ...blob(ABDOMEN.x * scale, ABDOMEN.rx * scale, ABDOMEN.ry * scale, font),
  ];
  const far = Math.max(...rests.map((rest) => Math.hypot(rest.x, rest.y)), ...body.map((g) => Math.hypot(g.x, g.y)));
  return {
    span,
    font,
    hips,
    rests,
    thigh: 40 * scale,
    shin: 30 * scale,
    stride,
    step: 150,
    lift: 4 * scale,
    speed: 170 * scale,
    turn: 6,
    accel: 1000 * scale,
    body,
    reach: far + stride,
  };
}

/** A point of body space in the world. */
export function toWorld(c: { x: number; y: number; heading: number }, p: Vec): Vec {
  const cos = Math.cos(c.heading);
  const sin = Math.sin(c.heading);
  return { x: c.x + p.x * cos - p.y * sin, y: c.y + p.x * sin + p.y * cos };
}

/** The difference between two angles, from -π to π. */
export function angleTo(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function toward(value: number, target: number, step: number): number {
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step);
}

/**
 * Two-bone inverse kinematics: the knee of a leg from its hip to a foot, by the law of cosines,
 * bent toward `outward` (the side of the body the leg is on). A foot out of reach is drawn at the
 * end of the straight leg, one too close at the end of the folded one. Returns the knee and the
 * foot the leg reaches.
 */
export function solveLeg(hip: Vec, foot: Vec, thigh: number, shin: number, outward: Vec): { knee: Vec; foot: Vec } {
  const dx = foot.x - hip.x;
  const dy = foot.y - hip.y;
  const length = Math.hypot(dx, dy) || 1e-6;
  const d = Math.min(Math.max(length, Math.abs(thigh - shin) + 1e-3), (thigh + shin) * 0.999);
  const ux = dx / length;
  const uy = dy / length;
  const a = Math.acos(Math.min(1, Math.max(-1, (thigh * thigh + d * d - shin * shin) / (2 * thigh * d))));
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const k1 = { x: hip.x + thigh * (ux * cos - uy * sin), y: hip.y + thigh * (ux * sin + uy * cos) };
  const k2 = { x: hip.x + thigh * (ux * cos + uy * sin), y: hip.y + thigh * (-ux * sin + uy * cos) };
  const out1 = (k1.x - hip.x) * outward.x + (k1.y - hip.y) * outward.y;
  const out2 = (k2.x - hip.x) * outward.x + (k2.y - hip.y) * outward.y;
  return { knee: out1 >= out2 ? k1 : k2, foot: { x: hip.x + ux * d, y: hip.y + uy * d } };
}

/** A new crawler standing in its resting pose. */
export function createCrawler(plan: BodyPlan, x: number, y: number, heading: number): Crawler {
  const c: Crawler = {
    plan,
    x,
    y,
    heading,
    speed: 0,
    legs: [],
    group: 0,
    route: [],
    face: null,
    pace: 1,
    gesture: null,
    time: 0,
    carry: 0,
  };
  c.legs = plan.rests.map((rest) => {
    const foot = toWorld(c, rest);
    return { foot, from: foot, to: foot, t: -1 };
  });
  return c;
}

/** Where a foot should be now: its rest under the moving body, led a little by the body's speed. */
export function idealFoot(c: Crawler, i: number): Vec {
  const rest = toWorld(c, c.plan.rests[i] ?? { x: 0, y: 0 });
  const lead = (c.speed * c.plan.step) / 2000;
  return { x: rest.x + Math.cos(c.heading) * lead, y: rest.y + Math.sin(c.heading) * lead };
}

/** Where a front leg's foot is held by a gesture at time `now`, or null. */
export function heldFoot(c: Crawler, i: number, now: number): Vec | null {
  const g = c.gesture;
  if (!g || (i !== FRONT[0] && i !== FRONT[1])) return null;
  const side = i === FRONT[0] ? 1 : -1;
  const elapsed = now - g.at;
  const scale = c.plan.span / UNIT;
  if (g.kind === 'tap') {
    if (elapsed >= TAP_MS * TAPS) return null;
    // Down on the spot at the middle of each tap, drawn back toward the body between them.
    const back = Math.atan2(c.y - g.spot.y, c.x - g.spot.x);
    const raise = 8 * scale * (0.5 + 0.5 * Math.cos((2 * Math.PI * elapsed) / TAP_MS));
    const across = back + Math.PI / 2;
    return {
      x: g.spot.x + Math.cos(back) * raise + Math.cos(across) * 4 * scale * side,
      y: g.spot.y + Math.sin(back) * raise + Math.sin(across) * 4 * scale * side,
    };
  }
  if (elapsed >= READ_MS) return null;
  // Each front foot runs along its own half of the edge, twice, one up while the other comes down.
  const u = 0.5 - 0.5 * Math.cos((4 * Math.PI * elapsed) / READ_MS);
  const along = side === 1 ? 0.5 + 0.5 * u : 0.5 - 0.5 * u;
  return { x: g.a.x + (g.b.x - g.a.x) * along, y: g.a.y + (g.b.y - g.a.y) * along };
}

/** Whether a gesture is still running at the crawler's own time. */
export function gesturing(c: Crawler): boolean {
  const g = c.gesture;
  return g !== null && c.time - g.at < (g.kind === 'tap' ? TAP_MS * TAPS : READ_MS);
}

/** One sub-step of TICK milliseconds. */
function tick(c: Crawler): void {
  const s = TICK / 1000;
  const p = c.plan;
  const scale = p.span / UNIT;
  const goal = c.route[0];
  if (goal) {
    const dx = goal.x - c.x;
    const dy = goal.y - c.y;
    const distance = Math.hypot(dx, dy);
    const last = c.route.length === 1;
    if (!last && distance < 12 * scale * Math.sqrt(c.pace)) {
      c.route.shift();
    } else if (last && distance < 0.25) {
      c.x = goal.x;
      c.y = goal.y;
      c.speed = 0;
      c.route.shift();
    } else {
      const want = Math.atan2(dy, dx);
      c.heading += Math.max(-p.turn * c.pace * s, Math.min(p.turn * c.pace * s, angleTo(c.heading, want)));
      const error = Math.abs(angleTo(c.heading, want));
      const brake = last ? Math.min(1, distance / (28 * scale * c.pace)) : 1;
      const top = p.speed * c.pace * Math.max(0, Math.cos(error)) ** 2 * Math.max(0.12, brake);
      c.speed = toward(c.speed, top, p.accel * c.pace * s);
      const move = Math.min(c.speed * s, distance);
      c.x += Math.cos(c.heading) * move;
      c.y += Math.sin(c.heading) * move;
    }
  } else {
    c.speed = 0;
    if (c.face !== null) {
      const d = angleTo(c.heading, c.face);
      c.heading += Math.max(-p.turn * s, Math.min(p.turn * s, d));
      if (Math.abs(d) < 1e-4) c.heading = c.face;
    }
  }

  c.time += TICK;
  if (c.gesture && !gesturing(c)) c.gesture = null;
  const still = c.route.length === 0 && c.speed === 0;
  const duration = p.step / Math.sqrt(c.pace);
  let busy = false;
  let landed = false;
  for (let i = 0; i < 8; i += 1) {
    const leg = c.legs[i] as Leg;
    const held = heldFoot(c, i, c.time);
    if (held) {
      // A held foot follows its gesture directly, never as a step of the gait.
      leg.t = -1;
      leg.foot = held;
      leg.from = held;
      leg.to = held;
      continue;
    }
    if (leg.t >= 0) {
      leg.t += TICK / duration;
      if (leg.t >= 1) {
        leg.t = -1;
        leg.foot = leg.to;
        landed = true;
      } else {
        const e = leg.t * leg.t * (3 - 2 * leg.t);
        leg.foot = { x: leg.from.x + (leg.to.x - leg.from.x) * e, y: leg.from.y + (leg.to.y - leg.from.y) * e };
        if (GROUP[i] === c.group) busy = true;
      }
    }
  }
  if (busy) return;
  // When a group has landed, the turn passes to the other. The group whose turn it is steps every
  // foot that lies too far from where it should be; when none does, the turn passes on. Standing
  // still, a smaller threshold tidies the stance, so the crawler always comes to rest in its pose.
  if (landed) c.group = 1 - c.group;
  const threshold = still ? 0.75 : p.stride;
  // A step lands where the foot should be when it lands, so the next turn is the other group's.
  const ahead = (c.speed * duration) / 1000;
  let started = false;
  for (let i = 0; i < 8; i += 1) {
    const leg = c.legs[i] as Leg;
    if (GROUP[i] !== c.group || heldFoot(c, i, c.time)) continue;
    const ideal = idealFoot(c, i);
    if (Math.hypot(ideal.x - leg.foot.x, ideal.y - leg.foot.y) > threshold) {
      leg.from = leg.foot;
      leg.to = { x: ideal.x + Math.cos(c.heading) * ahead, y: ideal.y + Math.sin(c.heading) * ahead };
      leg.t = 0;
      started = true;
    }
  }
  if (!started) c.group = 1 - c.group;
}

/** Advances the crawler by a frame of `ms` milliseconds (capped at MAX_FRAME). */
export function advance(c: Crawler, ms: number): void {
  c.carry += Math.min(Math.max(ms, 0), MAX_FRAME);
  while (c.carry >= TICK - 1e-6) {
    tick(c);
    c.carry -= TICK;
  }
}

/** Stands it where it is, at once: no route, no gesture, every foot planted where it rests. */
export function plant(c: Crawler): void {
  c.route = [];
  c.speed = 0;
  c.gesture = null;
  c.face = null;
  c.legs.forEach((leg, i) => {
    const foot = idealFoot(c, i);
    leg.foot = foot;
    leg.from = foot;
    leg.to = foot;
    leg.t = -1;
  });
}

/** Standing still: no route, no step, no gesture, every foot where it rests, facing where it was told. */
export function settled(c: Crawler): boolean {
  if (c.route.length > 0 || c.speed !== 0 || c.gesture) return false;
  if (c.face !== null && Math.abs(angleTo(c.heading, c.face)) > 1e-3) return false;
  return c.legs.every((leg, i) => {
    const ideal = idealFoot(c, i);
    return leg.t < 0 && Math.hypot(ideal.x - leg.foot.x, ideal.y - leg.foot.y) <= 0.75;
  });
}

/**
 * The line glyph for a stretch of leg, by its angle on the screen (y down): "-" near level, "|"
 * near upright, "\" and "/" on the diagonals. A chain of them reads as a line drawn in ASCII.
 */
export function lineGlyph(dx: number, dy: number): string {
  const t = ((((Math.atan2(dy, dx) * 180) / Math.PI) % 180) + 180) % 180;
  if (t < 22.5 || t >= 157.5) return '-';
  if (t >= 67.5 && t < 112.5) return '|';
  return t < 90 ? '\\' : '/';
}

/** Glyphs along a bone from a to b, about every 0.4 em so the stroke never shows a gap; b itself only when `last`. */
function bone(out: Glyph[], a: Vec, b: Vec, font: number, last: boolean): void {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(2, Math.round(length / (0.4 * font)));
  const ch = lineGlyph(b.x - a.x, b.y - a.y);
  for (let k = 1; k <= (last ? n : n - 1); k += 1) {
    out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, ch, heavy: false, size: font });
  }
}

/**
 * The crawler as glyphs: each leg a continuous stroke of line glyphs from the hip to the knee and
 * on to the foot, the knee where the stroke turns, the foot a small point; the head and the abdomen
 * the densest characters of the ramp. Centres in the model's coordinates.
 */
export function glyphs(c: Crawler): Glyph[] {
  const out: Glyph[] = [];
  const p = c.plan;
  const font = p.font;
  for (let i = 0; i < 8; i += 1) {
    const leg = c.legs[i] as Leg;
    const side = i < 4 ? 1 : -1;
    const hip = toWorld(c, p.hips[i] ?? { x: 0, y: 0 });
    let foot = leg.foot;
    if (leg.t >= 0) {
      // A foot in the air: a little out from the body, at the top of its step.
      const lift = p.lift * Math.sin(Math.PI * leg.t);
      const ox = foot.x - c.x;
      const oy = foot.y - c.y;
      const r = Math.hypot(ox, oy) || 1;
      foot = { x: foot.x + (ox / r) * lift, y: foot.y + (oy / r) * lift };
    }
    const outward = { x: -Math.sin(c.heading) * side, y: Math.cos(c.heading) * side };
    const bones = solveLeg(hip, foot, p.thigh, p.shin, outward);
    bone(out, hip, bones.knee, font, true);
    bone(out, bones.knee, bones.foot, font, false);
    out.push({ x: bones.foot.x, y: bones.foot.y, ch: '.', heavy: false, size: font });
  }
  for (const g of p.body) {
    const at = toWorld(c, g);
    out.push({ x: at.x, y: at.y, ch: g.ch, heavy: true, size: font });
  }
  return out;
}
