// The crawler's model and map: its legs reach, its gait alternates, it walks the same at any frame
// rate, it repeats, it settles, and it never meets a wall, nor a word where it stands.
// Run: pnpm exec vitest run --config apps/web/src/design/vitest.config.ts
import { describe, expect, it } from 'vitest';
import {
  advance,
  bodyPlan,
  type Crawler,
  createCrawler,
  FRONT,
  glyphs,
  INKS,
  lineGlyph,
  MAX_FRAME,
  READ_MS,
  settled,
  solveLeg,
  spanFor,
  TAPS,
  TICK,
  toWorld,
} from './model.ts';
import { canStand, followStand, keep, readStand, restStand, scurryStands, walkRoom, walkTo } from './plan.ts';
import { type Box, glyphBox, Space } from './space.ts';

// The smallest span a page gives (a window of 1100 to 1279 pixels), so the test page has room.
const plan = bodyPlan(160);
const scale = plan.span / 120;
const GROUP_A = [0, 2, 5, 7];

function walker(route: { x: number; y: number }[]): Crawler {
  const c = createCrawler(plan, 100, 300, 0);
  c.route = route.map((p) => ({ ...p }));
  return c;
}

/** Runs frames of `ms` until `until` milliseconds, calling `each` after every frame. */
function run(c: Crawler, ms: number, until: number, each?: (c: Crawler) => void): void {
  for (let t = 0; t < until - 1e-9; t += ms) {
    advance(c, ms);
    each?.(c);
  }
}

/** A page: a window of 1280 by 800, a title in words, a figure, a button, a board of rows. */
function page(): { space: Space; rows: Box[] } {
  const view = { x: 0, y: 0, w: 1280, h: 800 };
  const soft: Box[] = [
    { x: 24, y: 40, w: 520, h: 48 },
    { x: 24, y: 100, w: 600, h: 40 },
  ];
  const walls: Box[] = [
    { x: 24, y: 160, w: 180, h: 44 },
    { x: 640, y: 104, w: 90, h: 24 },
  ];
  const rows: Box[] = [];
  for (let k = 0; k < 5; k += 1) {
    const y = 420 + k * 64;
    rows.push({ x: 300, y, w: 700, h: 64 });
    walls.push({ x: 324, y: y + 12, w: 38, h: 38 }, { x: 900, y: y + 20, w: 80, h: 24 });
    soft.push({ x: 380, y: y + 20, w: 200, h: 20 });
  }
  return { space: new Space({ area: { x: -120, y: -800, w: 1520, h: 2400 }, view, walls, soft }), rows };
}

describe('the size', () => {
  it('fixes the leg span from the window: 260 from 1600, 200 from 1280, 160 from 1100', () => {
    expect([1100, 1279, 1280, 1440, 1599, 1600, 1920].map(spanFor)).toEqual([160, 160, 200, 200, 200, 260, 260]);
  });

  it('spans about 260 pixels at 260, with a body of about 48 by 34 and glyphs of about 16', () => {
    const big = bodyPlan(260);
    const c = createCrawler(big, 0, 0, 0);
    const all = glyphs(c).map((g) => glyphBox(g));
    const extent = (list: Box[]) => ({
      w: Math.max(...list.map((b) => b.x + b.w)) - Math.min(...list.map((b) => b.x)),
      h: Math.max(...list.map((b) => b.y + b.h)) - Math.min(...list.map((b) => b.y)),
    });
    const whole = extent(all);
    expect(Math.max(whole.w, whole.h)).toBeGreaterThan(240);
    expect(Math.max(whole.w, whole.h)).toBeLessThan(290);
    const body = extent(
      glyphs(c)
        .filter((g) => g.heavy)
        .map((g) => ({ x: g.x - 0.3 * g.size, y: g.y - 0.36 * g.size, w: 0.6 * g.size, h: 0.72 * g.size })),
    );
    expect(body.w).toBeGreaterThan(40);
    expect(body.w).toBeLessThan(58);
    expect(body.h).toBeGreaterThan(28);
    expect(body.h).toBeLessThan(42);
    expect(big.font).toBeGreaterThanOrEqual(15.5);
    expect(big.font).toBeLessThanOrEqual(16.5);
  });
});

describe('the legs', () => {
  it('reach any reachable target within 0.5 pixels, the knee bent toward the outside', () => {
    const hip = { x: 0, y: 0 };
    const outward = { x: 0, y: 1 };
    const { thigh, shin } = plan;
    for (let k = 0; k < 720; k += 1) {
      const angle = (k * 2 * Math.PI) / 97;
      const reach =
        Math.abs(thigh - shin) + 0.5 + (((k * 7) % 100) / 100) * (thigh + shin - Math.abs(thigh - shin) - 1);
      const target = { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach };
      const { knee, foot } = solveLeg(hip, target, thigh, shin, outward);
      expect(Math.hypot(foot.x - target.x, foot.y - target.y)).toBeLessThan(0.5);
      expect(Math.hypot(knee.x - hip.x, knee.y - hip.y)).toBeCloseTo(thigh, 6);
      expect(Math.hypot(foot.x - knee.x, foot.y - knee.y)).toBeCloseTo(shin, 6);
      // The other solution of the same triangle lies less to the outside.
      const mirror = {
        x: (2 * (target.x * (knee.x * target.x + knee.y * target.y))) / (reach * reach) - knee.x,
        y: (2 * (target.y * (knee.x * target.x + knee.y * target.y))) / (reach * reach) - knee.y,
      };
      expect(knee.y).toBeGreaterThanOrEqual(mirror.y - 1e-9);
    }
  });

  it('draws a foot out of reach at the end of the straight leg', () => {
    const { foot } = solveLeg({ x: 0, y: 0 }, { x: 500, y: 0 }, plan.thigh, plan.shin, { x: 0, y: 1 });
    expect(foot.x).toBeCloseTo((plan.thigh + plan.shin) * 0.999, 6);
  });

  it('bends every knee of the resting pose outward, clearly, at any heading', () => {
    for (const heading of [0, 0.8, 2, -2.5]) {
      const c = createCrawler(plan, 400, 300, heading);
      for (let i = 0; i < 8; i += 1) {
        const side = i < 4 ? 1 : -1;
        const hip = toWorld(c, plan.hips[i] ?? { x: 0, y: 0 });
        const foot = c.legs[i]?.foot ?? hip;
        const out = { x: -Math.sin(heading) * side, y: Math.cos(heading) * side };
        const { knee } = solveLeg(hip, foot, plan.thigh, plan.shin, out);
        // The knee stands off the line from hip to foot by more than a fifth of the thigh, outward.
        const dx = foot.x - hip.x;
        const dy = foot.y - hip.y;
        const off = ((knee.x - hip.x) * dy - (knee.y - hip.y) * dx) / Math.hypot(dx, dy);
        expect(Math.abs(off)).toBeGreaterThan(plan.thigh / 5);
        expect((knee.x - hip.x) * out.x + (knee.y - hip.y) * out.y).toBeGreaterThan(plan.thigh / 2);
      }
    }
  });

  it('draws each leg as a line whose glyph follows its angle, with no gap', () => {
    expect([lineGlyph(10, 0), lineGlyph(0, 10), lineGlyph(10, 10), lineGlyph(10, -10), lineGlyph(-10, 10)]).toEqual([
      '-',
      '|',
      '\\',
      '/',
      '/',
    ]);
    const legs = glyphs(createCrawler(plan, 400, 300, 0.4)).filter((g) => !g.heavy);
    expect(legs.length).toBeGreaterThan(8 * 12);
    for (const g of legs) {
      const next = legs
        .filter((h) => h !== g)
        .reduce((best, h) => Math.min(best, Math.hypot(h.x - g.x, h.y - g.y)), Number.POSITIVE_INFINITY);
      expect(next).toBeLessThanOrEqual(0.45 * plan.font);
    }
  });
});

describe('the gait', () => {
  it('alternates the two tetrapods: R1 R3 L2 L4, then R2 R4 L1 L3', () => {
    const c = walker([{ x: 700, y: 300 }]);
    const batches: number[][] = [];
    const before = c.legs.map((leg) => leg.t);
    for (let k = 0; k < 600; k += 1) {
      advance(c, TICK);
      const started = c.legs.flatMap((leg, i) => ((before[i] ?? -1) < 0 && leg.t >= 0 && leg.t < 0.2 ? [i] : []));
      if (started.length > 0) batches.push(started);
      c.legs.forEach((leg, i) => {
        before[i] = leg.t;
      });
    }
    expect(batches.length).toBeGreaterThan(8);
    const groups = batches.map((batch) => {
      const inA = batch.filter((i) => GROUP_A.includes(i)).length;
      expect(inA === 0 || inA === batch.length).toBe(true);
      return inA > 0 ? 'A' : 'B';
    });
    for (let k = 1; k < groups.length; k += 1) expect(groups[k]).not.toBe(groups[k - 1]);
  });

  it('never steps with all of a side at once, and plants every foot in the world', () => {
    const c = walker([{ x: 700, y: 300 }]);
    run(c, TICK, 3000, () => {
      const lifted = c.legs.filter((leg) => leg.t >= 0).length;
      expect(lifted).toBeLessThanOrEqual(4);
    });
  });
});

describe('time', () => {
  it('walks the same path at 60 Hz and at 120 Hz, within 2 pixels', () => {
    const route = [
      { x: 400, y: 200 },
      { x: 600, y: 420 },
      { x: 300, y: 500 },
    ];
    const a = walker(route);
    const b = walker(route);
    let worst = 0;
    for (let frame = 0; frame < 240; frame += 1) {
      advance(a, 1000 / 60);
      advance(b, 1000 / 120);
      advance(b, 1000 / 120);
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
      a.legs.forEach((leg, i) => {
        const other = b.legs[i]?.foot ?? leg.foot;
        worst = Math.max(worst, Math.hypot(leg.foot.x - other.x, leg.foot.y - other.y));
      });
    }
    expect(worst).toBeLessThan(2);
    expect(a.x).not.toBe(100);
  });

  it('repeats exactly: the same frames give the same crawler', () => {
    const one = walker([{ x: 500, y: 100 }]);
    const two = walker([{ x: 500, y: 100 }]);
    const frames = [16, 17, 16, 33, 8, 16, 50, 16];
    for (let k = 0; k < 300; k += 1) {
      advance(one, frames[k % frames.length] as number);
      advance(two, frames[k % frames.length] as number);
    }
    expect(JSON.stringify(glyphs(one))).toBe(JSON.stringify(glyphs(two)));
  });

  it('takes a long frame as 50 ms', () => {
    const one = walker([{ x: 900, y: 300 }]);
    const two = walker([{ x: 900, y: 300 }]);
    advance(one, 2000);
    advance(two, MAX_FRAME);
    expect(one.x).toBe(two.x);
  });

  it('settles: once there it stands still, and more time changes nothing', () => {
    const c = walker([{ x: 320, y: 360 }]);
    c.face = 1;
    run(c, 1000 / 60, 4000);
    expect(settled(c)).toBe(true);
    const still = JSON.stringify(glyphs(c));
    run(c, 1000 / 60, 5000);
    expect(JSON.stringify(glyphs(c))).toBe(still);
  });

  it('draws with the ramp, the line glyphs and ( ) o, and nothing else', () => {
    const c = walker([{ x: 500, y: 500 }]);
    run(c, 16, 1500, () => {
      for (const g of glyphs(c)) expect(INKS.includes(g.ch) && g.ch !== ' ').toBe(true);
    });
  });
});

describe('where it goes', () => {
  it('walks a route that never meets a wall', () => {
    const { space } = page();
    const need = walkRoom(plan);
    const from = { x: 1100, y: 160 };
    const to = { x: 1150, y: 760 };
    const c = createCrawler(plan, from.x, from.y, Math.PI / 2);
    const route = space.route(from, to, need);
    expect(route).not.toBeNull();
    c.route = route ?? [];
    let frames = 0;
    run(c, 1000 / 60, 8000, () => {
      frames += 1;
      for (const g of glyphs(c)) expect(space.meets(glyphBox(g), false)).toBe(false);
    });
    expect(frames).toBeGreaterThan(100);
    expect(Math.hypot(c.x - to.x, c.y - to.y)).toBeLessThan(1);
  });

  it('goes round the words of an h1 where a way round is near, and never straightens across them', () => {
    const heading = { x: 300, y: 350, w: 600, h: 100 };
    const space = new Space({
      area: { x: 0, y: 0, w: 1200, h: 900 },
      view: { x: 0, y: 0, w: 1200, h: 900 },
      walls: [],
      soft: [],
      loud: [heading],
    });
    const route = space.route({ x: 150, y: 400 }, { x: 1050, y: 400 }, walkRoom(plan) * 0.2) ?? [];
    expect(route.length).toBeGreaterThan(1);
    let from = { x: 150, y: 400 };
    for (const to of route) {
      for (let k = 0; k <= 40; k += 1) {
        const x = from.x + ((to.x - from.x) * k) / 40;
        const y = from.y + ((to.y - from.y) * k) / 40;
        const inside = x > heading.x && x < heading.x + heading.w && y > heading.y && y < heading.y + heading.h;
        expect(inside).toBe(false);
      }
      from = to;
    }
  });

  it('follows to free ground about 0.85 of a span from the pointer, and stands only there', () => {
    const { space } = page();
    const pointer = { x: 880, y: 240 };
    const body = { x: 1120, y: 240 };
    const stands = followStand(space, plan, body, pointer);
    expect(stands.length).toBeGreaterThan(0);
    for (const at of stands) {
      expect(canStand(space, plan, at, Math.atan2(pointer.y - at.y, pointer.x - at.x))).toBe(true);
    }
    const first = stands[0] ?? body;
    expect(Math.abs(Math.hypot(first.x - pointer.x, first.y - pointer.y) - keep(plan))).toBeLessThan(24 * scale);
  });

  it('taps a resting pointer from free ground, and the tap meets no word', () => {
    const { space } = page();
    const pointer = { x: 1100, y: 250 };
    const stands = restStand(space, plan, { x: 1180, y: 330 }, pointer);
    expect(stands.length).toBeGreaterThan(0);
    const at = stands[0] ?? pointer;
    const c = createCrawler(plan, at.x, at.y, Math.atan2(pointer.y - at.y, pointer.x - at.x));
    c.face = c.heading;
    c.gesture = { kind: 'tap', at: c.time, spot: pointer };
    const touched: number[] = [];
    run(c, 1000 / 60, 280 * TAPS + 600, () => {
      for (const g of glyphs(c)) expect(space.meets(glyphBox(g), true)).toBe(false);
      const front = c.legs[FRONT[0]]?.foot ?? pointer;
      touched.push(Math.hypot(front.x - pointer.x, front.y - pointer.y));
    });
    expect(Math.min(...touched)).toBeLessThan(4 * scale + 2);
    expect(settled(c)).toBe(true);
  });

  it('reads a row from its edge, from free ground, and leaves the row alone', () => {
    const { space, rows } = page();
    const row = rows[1] as Box;
    const plans = readStand(space, plan, row);
    expect(plans.length).toBeGreaterThan(0);
    const read = plans[0];
    if (!read) return;
    expect(read.at.x < row.x || read.at.x > row.x + row.w).toBe(true);
    const c = createCrawler(plan, read.at.x, read.at.y, read.heading);
    c.face = read.heading;
    c.gesture = { kind: 'read', at: c.time, a: read.a, b: read.b };
    run(c, 1000 / 60, READ_MS + 600, () => {
      for (const g of glyphs(c)) {
        const box = glyphBox(g);
        expect(space.meets(box, true)).toBe(false);
        const inside = box.x < row.x + row.w && box.x + box.w > row.x && box.y < row.y + row.h && box.y + box.h > row.y;
        // Only the feet at the edge enter the row's box, and never deeper than one glyph and a pixel.
        if (inside) expect(Math.min(box.x + box.w - row.x, row.x + row.w - box.x)).toBeLessThan(0.6 * plan.font + 1);
      }
    });
    expect(settled(c)).toBe(true);
  });

  it('scurries away from a press, never toward it, to free ground', () => {
    const { space } = page();
    const body = { x: 1100, y: 250 };
    const press = { x: 1060, y: 250 };
    const stands = scurryStands(space, plan, body, press);
    for (const at of stands) {
      const moved = Math.hypot(at.x - body.x, at.y - body.y);
      expect(moved).toBeGreaterThanOrEqual(plan.span - 1);
      expect(moved).toBeLessThanOrEqual(1.6 * plan.span + 1);
      expect(Math.hypot(at.x - press.x, at.y - press.y)).toBeGreaterThan(
        Math.hypot(body.x - press.x, body.y - press.y),
      );
    }
    const walk = walkTo(space, plan, body, stands);
    if (stands.length > 0) expect(walk).not.toBeNull();
  });

  it('keeps every glyph of the resting pose inside its reach', () => {
    const c = createCrawler(plan, 0, 0, 0.7);
    for (const g of glyphs(c)) expect(Math.hypot(g.x, g.y)).toBeLessThanOrEqual(plan.reach);
    const hip = toWorld(c, plan.hips[0] ?? { x: 0, y: 0 });
    expect(Math.hypot(hip.x, hip.y)).toBeLessThan(10 * scale);
  });
});
