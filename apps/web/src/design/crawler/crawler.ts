/*! The crawler follows the idea of "Web crawlers" by Slava Rybin (@rybinfx), 2026-10-01,
https://x.com/rybinfx/status/2105700296760688790. Drawn and coded by Prix. */

/**
 * The crawler (docs/DESIGN.md section 30, D-154): an eight-legged reader drawn only in glyphs of
 * "Prix ASCII" (the field's ramp, the strokes / \ | - _ and ( ) o), its legs in --crawler-ink and
 * its body a step brighter in --crawler-ink-body, no hue. Its leg span is fixed once per page load
 * from the window's width (260 pixels from 1600, 200 from 1280, 160 from 1100). On a desktop it
 * follows the pointer, taps a resting pointer, reads an agent's row from the row's edge and
 * scurries off at a press; a phone never loads it. It never touches content: it is drawn only
 * where the map of crawler/space.ts allows, it changes nothing in the page, and it has no idle loop.
 *
 * The idea of a spider that crawls a web page, placing its legs by inverse kinematics and
 * following the pointer, is Slava Rybin's ("Web crawlers", X, 2026-10-01 16:44:07 UTC). The
 * drawing, the material and the code are Prix's: nothing of his clip, nor of
 * felixyu9722/WebCrawlerMY or cyohei9907/web-crawlers (both unlicensed), is copied.
 *
 * crawler/gate.ts decides whether this module loads at all, and when; crawler/crawl.ts is the
 * bundle that starts it.
 */
import {
  advance,
  angleTo,
  bodyPlan,
  type Crawler,
  createCrawler,
  type Glyph,
  glyphs,
  plant,
  settled,
  spanFor,
  type Vec,
} from './model.ts';
import {
  canStand,
  followStand,
  nearestSide,
  offside,
  pose,
  type ReadPlan,
  readStand,
  restStand,
  scare,
  scurryStands,
  standsNear,
  walkRoom,
  walkTo,
} from './plan.ts';
import { type Scene, scan } from './scan.ts';
import { type Box, FREE, glyphBox, Space } from './space.ts';

/** The rows it reads: Standings' rows, a BoardList's cards, the body rows of a league Table. */
const ROWS = '[data-crawler-row],[data-crawler-rows]>[data-agent],[data-crawler-rows]>tbody>tr';
/** sessionStorage: set when this device was too slow, so the crawler stays away for the session. */
export const SLOW_KEY = 'prix-crawler';
/** Within this long of the pointer's last move it stands, and the frame loop stops (F2 of the first review). */
const STILL_MS = 4000;
/** The longest walk it takes at once, in seconds of walking at its own pace. */
const WALK_S = 3;

type Mode = 'walk' | 'stand' | 'tap' | 'read' | 'out';
type Then = { tap: Vec } | { read: { a: Vec; b: Vec } } | { out: -1 | 1 } | { via: ReadPlan } | null;
/** The pace of a walk round the page's edge to a row it cannot reach across the page. */
const HURRY = 2.5;
interface Cell extends Box {
  colour: string;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;
const facing = (from: Vec, to: Vec) => Math.atan2(to.y - from.y, to.x - from.x);

export function start(clientX: number, clientY: number): void {
  const main = document.querySelector<HTMLElement>('main[data-crawler]');
  if (!main || main.querySelector(':scope > .crawler')) return;
  const layer = document.createElement('div');
  layer.className = 'crawler';
  layer.setAttribute('aria-hidden', 'true');
  // The minifier drops comments, so the credit rides in the chunk and on the crawler's own layer.
  layer.dataset.credit =
    'The idea: "Web crawlers" by Slava Rybin (@rybinfx), 2026-10-01, https://x.com/rybinfx/status/2105700296760688790. Drawn and coded by Prix.';
  const canvas = document.createElement('canvas');
  layer.append(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // After the field, never last: the layout's rules that look at the last child of `main` stay true.
  const ground = main.querySelector(':scope > .ground');
  if (ground) ground.after(layer);
  else main.prepend(layer);

  // The span is fixed once per page load: a resize redraws the map, never the crawler.
  const plan = bodyPlan(spanFor(document.documentElement.clientWidth));
  const size = Math.ceil(plan.reach * 2 + 72);
  const off = new AbortController();
  const on = { passive: true, signal: off.signal };
  let dpr = 0;
  /** Where the canvas stands in the page, moved only when the crawler nears its edge. */
  let cx = Number.NaN;
  let cy = Number.NaN;
  // Read once below, before anything uses them, and again whenever the page changes.
  let scene!: Scene;
  let space!: Space;
  let scrolled: Vec = { x: 0, y: 0 };
  let buckets = new Map<number, Cell[]>();
  let built = 0;
  let ink = '';
  let inkBody = '';
  let colour: (y: number) => string = () => '';

  /** One small canvas per glyph and weight, drawn once per ink, font and device scale. */
  let sprites = { w: 0, h: 0, all: new Map<string, HTMLCanvasElement>() };
  const resprite = () => {
    sprites = { w: Math.ceil(plan.font * dpr), h: Math.ceil(plan.font * 1.4 * dpr), all: new Map() };
  };
  const sprite = (ch: string, heavy: boolean): HTMLCanvasElement => {
    const key = `${heavy ? 'b' : 'l'}${ch}`;
    let s = sprites.all.get(key);
    if (!s) {
      s = document.createElement('canvas');
      s.width = sprites.w;
      s.height = sprites.h;
      const g = s.getContext('2d');
      if (g) {
        g.scale(dpr, dpr);
        g.font = `${heavy ? 700 : 400} ${plan.font}px "Prix ASCII"`;
        g.fillStyle = heavy ? inkBody : ink;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(ch, sprites.w / dpr / 2, sprites.h / dpr / 2);
      }
      sprites.all.set(key, s);
    }
    return s;
  };

  const resize = () => {
    const d = window.devicePixelRatio || 1;
    if (d === dpr) return;
    dpr = d;
    resprite();
    canvas.width = Math.round(size * d);
    canvas.height = Math.round(size * d);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    cx = Number.NaN;
  };

  /** The page's own colours: the ink, and the ground under the field of characters at a height. */
  const paints = () => {
    const style = getComputedStyle(main);
    const read = (name: string): number[] => {
      ctx.fillStyle = '#000';
      ctx.fillStyle = style.getPropertyValue(name).trim() || '#000';
      const value = String(ctx.fillStyle);
      if (value[0] === '#') return [1, 3, 5].map((k) => Number.parseInt(value.slice(k, k + 2), 16)).concat(1);
      const n = (value.match(/[\d.]+/g) ?? []).map(Number);
      return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1];
    };
    ink = style.getPropertyValue('--crawler-ink').trim();
    inkBody = style.getPropertyValue('--crawler-ink-body').trim();
    resprite();
    const raised = read('--raised');
    const base = read('--ground');
    const tint = read('--hero-tint');
    const rem = 24 * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    const hero = main.querySelector(':scope > .zone--hero');
    const top = main.getBoundingClientRect().top;
    const heroTop = hero ? hero.getBoundingClientRect().top - top : 0;
    const band = Math.min(main.getBoundingClientRect().height, rem);
    const mix = (a: number[], b: number[], t: number) =>
      `rgb(${[0, 1, 2].map((k) => Math.round((a[k] ?? 0) * (1 - t) + (b[k] ?? 0) * t)).join(' ')})`;
    // base.css: the band of the page head fades the raised surface into the ground over 24rem; the
    // hero lays its faint ink light from its top over the raised surface.
    colour = hero
      ? (y) => mix(raised, tint, (tint[3] ?? 0) * Math.max(0, 1 - (y - heroTop) / rem))
      : (y) => mix(raised, base, Math.min(1, Math.max(0, y / band)));
  };

  const build = () => {
    const begun = performance.now();
    scene = scan(main, layer, plan.reach * 2 + 40);
    space = new Space(scene);
    scrolled = { x: window.scrollX, y: window.scrollY };
    buckets = new Map();
    for (const box of scene.field) {
      const cell = { ...box, colour: colour(box.y + box.h / 2) };
      for (const key of keys(box)) buckets.set(key, [...(buckets.get(key) ?? []), cell]);
    }
    built = performance.now() - begun;
  };
  const keys = (b: Box) => {
    const out: number[] = [];
    for (let y = Math.floor(b.y / 16); y <= Math.floor((b.y + b.h) / 16); y += 1) {
      for (let x = Math.floor(b.x / 16); x <= Math.floor((b.x + b.w) / 16); x += 1) out.push(y * 8192 + x);
    }
    return out;
  };
  const local = (x: number, y: number): Vec => ({
    x: x - scene.origin.x + window.scrollX - scrolled.x,
    y: y - scene.origin.y + window.scrollY - scrolled.y,
  });

  resize();
  paints();
  build();

  let c: Crawler = createCrawler(plan, 0, 0, 0);
  // It starts out of sight: its first follow brings it in (R20).
  let mode: Mode = 'out';
  /** Out of sight with a timer that brings it back; out without one, the next pointer move does. */
  let returning = false;
  let then: Then = null;
  let pointer: Vec | null = null;
  let raf = 0;
  let last = 0;
  let frozen = false;
  /** When the pointer last moved or pressed, or the crawler last came back in. */
  let moved = performance.now();
  let shown: Glyph[] = [];
  let dropped = 0;
  let frames = 0;
  // Counted for the page driver of a sample build only (crawler-check.mjs).
  let drawn = 0;
  let work = 0;
  const works: number[] = [];
  const gaps: number[] = [];
  /** Planning time since the last frame, added to that frame's own work. */
  let planning = 0;
  const timed = (run: () => void) => {
    const begun = performance.now();
    run();
    planning += performance.now() - begun;
  };
  const timers = new Map<string, number>();
  const later = (name: string, ms: number, run: () => void) => {
    clearTimeout(timers.get(name));
    timers.set(name, window.setTimeout(run, ms));
  };
  const cancel = (...names: string[]) => {
    for (const name of names) clearTimeout(timers.get(name));
  };

  const draw = () => {
    const standing = mode === 'stand' || mode === 'tap' || mode === 'read';
    const all = glyphs(c);
    // The last guard: a glyph that would meet a wall, or a word while it stands, is not drawn.
    shown = all.filter((g) => !space.meets(glyphBox(g), standing));
    dropped += all.length - shown.length;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = x0;
    let x1 = -x0;
    let y1 = -x0;
    for (const g of shown) {
      x0 = Math.min(x0, g.x);
      y0 = Math.min(y0, g.y);
      x1 = Math.max(x1, g.x);
      y1 = Math.max(y1, g.y);
    }
    // The canvas moves only when the crawler nears its edge: one transform, never a layout.
    if (!(x0 >= cx + 16 && y0 >= cy + 16 && x1 <= cx + size - 16 && y1 <= cy + size - 16)) {
      cx = Math.round(c.x - size / 2);
      cy = Math.round(c.y - size / 2);
      canvas.style.transform = `translate(${cx}px,${cy}px)`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, -cx * dpr, -cy * dpr);
    ctx.clearRect(cx, cy, size, size);
    // Where it crosses the field, only the part of a field cell under a glyph's ink is cleared to
    // the ground beneath, so no two glyphs overlap and no hole opens around it (F7 of the first
    // review): the ink box is 0.55 em by 0.8 em, not the whole cell.
    const iw = 0.55 * plan.font;
    const ih = 0.8 * plan.font;
    for (const g of shown) {
      const box = { x: g.x - iw / 2, y: g.y - ih / 2, w: iw, h: ih };
      for (const key of keys(box)) {
        for (const cell of buckets.get(key) ?? []) {
          const x0 = Math.max(cell.x, box.x);
          const y0 = Math.max(cell.y, box.y);
          const x1 = Math.min(cell.x + cell.w, box.x + box.w);
          const y1 = Math.min(cell.y + cell.h, box.y + box.h);
          if (x1 <= x0 || y1 <= y0) continue;
          ctx.fillStyle = cell.colour;
          ctx.fillRect(x0 - 0.5, y0 - 0.5, x1 - x0 + 1, y1 - y0 + 1);
        }
      }
    }
    // Each glyph is copied from its sprite, set on the device's pixel grid: a frame copies pixels
    // and never shapes text.
    const sw = sprites.w / dpr;
    const sh = sprites.h / dpr;
    for (const g of shown) {
      const x = Math.round((g.x - sw / 2) * dpr) / dpr;
      const y = Math.round((g.y - sh / 2) * dpr) / dpr;
      ctx.drawImage(sprite(g.ch, g.heavy), x, y, sw, sh);
    }
  };

  const kick = () => {
    if (!raf && !frozen && !document.hidden) raf = requestAnimationFrame(frame);
  };
  const halt = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    cancel('rest', 'row', 'follow');
  };

  const go = (route: Vec[] | null, face: number | null, next: Then, pace = 1): boolean => {
    if (!route) return false;
    // Every walk is capped: no longer than 2.5 times the straight way and half a span, and no
    // longer than WALK_S seconds at its pace. A longer one is not taken.
    let length = 0;
    let from: Vec = c;
    for (const p of route) {
      length += Math.hypot(p.x - from.x, p.y - from.y);
      from = p;
    }
    const straight = Math.hypot(from.x - c.x, from.y - c.y);
    if (length > straight * 2.5 + plan.span * 0.5 || length > plan.speed * pace * WALK_S) return false;
    c.route = route;
    c.face = face;
    c.pace = pace;
    c.gesture = null;
    then = next;
    mode = 'walk';
    kick();
    return true;
  };
  const turn = (to: Vec) => {
    c.route = [];
    c.gesture = null;
    then = null;
    c.face = facing(c, to);
    mode = 'walk';
    kick();
  };
  const leave = (side: -1 | 1, pace = 1) => {
    const out = offside(space, plan, side, c.y);
    const route = space.route(c, out, walkRoom(plan)) ?? space.route(c, out, walkRoom(plan) * 0.6);
    if (go(route, null, { out: side }, pace)) return;
    // No way out from here: it is simply gone, never drawn through a wall, and back 3 s later.
    mode = 'out';
    then = null;
    ctx.clearRect(cx, cy, size, size);
    returning = true;
    later('back', 3000, () => back(side));
  };

  /** Where the front feet tap: on the spot, or drawn back toward the body until they stand on free ground. */
  const tapSpot = (from: Vec, spot: Vec): Vec => {
    const back = facing(spot, from);
    const reach = plan.span * 0.16;
    const wide = (plan.span / 120) * 4;
    for (let k = 0; k <= reach; k += 4) {
      const at = { x: spot.x + Math.cos(back) * k, y: spot.y + Math.sin(back) * k };
      const across = { x: Math.cos(back + Math.PI / 2) * wide, y: Math.sin(back + Math.PI / 2) * wide };
      const feet = [
        { x: at.x + across.x, y: at.y + across.y },
        { x: at.x - across.x, y: at.y - across.y },
      ];
      if (feet.every((f) => !space.meets(glyphBox(f, plan.font), true))) return at;
    }
    return spot;
  };

  /** A walk to a place about `keep` from the pointer, facing it; false when none is taken. */
  const approach = (to: Vec): boolean => {
    const route = walkTo(space, plan, c, followStand(space, plan, c, to));
    const end = route?.[route.length - 1];
    return go(route, end ? facing(end, to) : null, null);
  };
  /** Whether any of it can lie in the window: its centre within its reach of the window. */
  const inSight = () => {
    const v = space.view;
    const r = plan.reach;
    return c.x > v.x - r && c.x < v.x + v.w + r && c.y > v.y - r && c.y < v.y + v.h + r;
  };
  const follow = () => {
    if (!pointer || returning || (mode !== 'out' && c.pace > 1)) return;
    if (mode !== 'out' && approach(pointer)) return;
    if (mode === 'out' || !inSight()) {
      // Out of sight with the pointer in the page (its first move, a long scroll, no way back): in
      // at the side edge nearest the pointer, at a height where it can stand. When no walk in is
      // taken it stays out, and the next pointer move tries again (R20).
      enter(pointer);
      if (approach(pointer)) return;
      mode = 'out';
      then = null;
      planned = { x: Number.POSITIVE_INFINITY, y: 0 };
      return;
    }
    // No place fits it near the pointer: it keeps the walk it is on, or waits and turns to the pointer.
    if (c.route.length === 0) turn(pointer);
  };
  const rest = () => {
    if (!pointer || mode === 'out' || c.pace > 1 || space.at(pointer.x, pointer.y) !== FREE) return;
    const route = walkTo(space, plan, c, restStand(space, plan, c, pointer));
    const end = route?.[route.length - 1];
    if (route && end) go(route, facing(end, pointer), { tap: tapSpot(end, pointer) });
  };
  const read = (row: Element) => {
    if (mode === 'out' || c.pace > 1) return;
    const rect = row.getBoundingClientRect();
    const box = { ...local(rect.left, rect.top), w: rect.width, h: rect.height };
    const plans = readStand(space, plan, box);
    if (__PRIX_FIXTURES__) reads.push({ row: box, at: plans.map((p) => p.at), from: { x: c.x, y: c.y } });
    for (const r of plans) {
      if (go(walkTo(space, plan, c, [r.at]), r.heading, { read: { a: r.a, b: r.b } })) return;
    }
    // A place to read from that it cannot reach across the page (the page's blocks are narrower
    // than its body): it hurries out at its nearest side edge and in at the edge nearest the place.
    const r = plans[0];
    if (r) {
      const side = nearestSide(space, c);
      const out = offside(space, plan, side, c.y);
      if (go(space.route(c, out, walkRoom(plan)), null, { via: r }, HURRY)) return;
      if (__PRIX_FIXTURES__) reads.push({ failed: 'out', route: space.route(c, out, walkRoom(plan))?.length ?? null });
    }
    turn({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
  };
  // What each read planned, for the page driver of a sample build only.
  const reads: unknown[] = [];
  const scurry = (press: Vec) => {
    if (mode === 'out' || Math.hypot(press.x - c.x, press.y - c.y) > scare(plan)) return;
    const stands = scurryStands(space, plan, c, press);
    const route = walkTo(space, plan, c, stands);
    const end = route?.[route.length - 1];
    if (go(route, end ? facing(press, end) : null, null, 3)) return;
    // Nowhere to go on the page: out at the nearest side edge, never past the reader.
    let side = nearestSide(space, c);
    if ((press.x - c.x) * side > 0) side = side < 0 ? 1 : -1;
    leave(side, 3);
  };
  /** How far its resting pose reaches above and below its centre when it faces a side edge. */
  const tall = Math.max(
    ...pose(plan, { x: 0, y: 0 }, 0).map((g) => {
      const b = glyphBox(g);
      return Math.max(-b.y, b.y + b.h);
    }),
  );
  /**
   * The heights where it can come in and stand, in the page's coordinates: the part of the window
   * that `main`'s map covers, less `tall` at the top and the bottom; its middle when that part is
   * lower than the crawler.
   */
  const band = (): [number, number] => {
    const v = space.view;
    const top = Math.max(v.y, scene.area.y) + tall;
    const bottom = Math.min(v.y + v.h, scene.area.y + scene.area.h) - tall;
    return top <= bottom ? [top, bottom] : [(top + bottom) / 2, (top + bottom) / 2];
  };
  const clamp = (n: number, [low, high]: [number, number]) => Math.min(Math.max(n, low), high);
  /**
   * In just outside the side edge nearest a point, at the point's height brought into the band
   * where it can stand, the side picked from that clamped point. A point over the header, above
   * `main`, never leaves it off the map, where no route starts (R20).
   */
  const enter = (at: Vec) => {
    const v = space.view;
    const to = { x: clamp(at.x, [v.x, v.x + v.w]), y: clamp(at.y, band()) };
    const side = nearestSide(space, to);
    const from = offside(space, plan, side, to.y);
    c = createCrawler(plan, from.x, from.y, side < 0 ? 0 : Math.PI);
    cx = Number.NaN;
  };

  const frame = (now: number) => {
    raf = 0;
    const begun = performance.now();
    const gap = last ? now - last : 1000 / 60;
    if (last && frames < 60) gaps.push(gap);
    last = now;
    advance(c, gap);
    if (c.route.length === 0) {
      c.pace = 1;
      const next = then;
      const facingDone = c.face === null || Math.abs(angleTo(c.heading, c.face)) < 0.02;
      if (next && 'via' in next) {
        // Out of sight at one side edge: in at the edge nearest the place it reads from.
        then = null;
        const r = next.via;
        enter(r.at);
        const inward = walkTo(space, plan, c, [r.at]);
        if (!go(inward, r.heading, { read: { a: r.a, b: r.b } }, HURRY)) {
          // Out of sight with no way in: the next pointer move brings it in (R20).
          mode = 'out';
          if (__PRIX_FIXTURES__) reads.push({ failed: 'in', from: { x: c.x, y: c.y }, route: inward?.length ?? null });
        }
      } else if (next && 'out' in next) {
        then = null;
        mode = 'out';
        returning = true;
        later('back', 3000, () => back(next.out));
      } else if (next && facingDone) {
        then = null;
        if ('tap' in next) {
          c.gesture = { kind: 'tap', at: c.time, spot: next.tap };
          mode = 'tap';
        } else {
          c.gesture = { kind: 'read', at: c.time, a: next.read.a, b: next.read.b };
          mode = 'read';
        }
      }
    }
    if ((mode === 'tap' || mode === 'read') && !c.gesture) mode = 'walk';
    if (mode !== 'out' && performance.now() - moved >= STILL_MS) {
      // The hard rule: within STILL_MS of the pointer's last move it stands where it is.
      then = null;
      if (!settled(c)) plant(c);
      mode = 'stand';
    }
    if (mode !== 'out') draw();
    else ctx.clearRect(cx, cy, size, size);
    const spent = performance.now() - begun + planning;
    planning = 0;
    if (__PRIX_FIXTURES__) {
      drawn += 1;
      work += spent;
    }
    if (frames < 60) {
      works.push(spent);
      frames += 1;
      if (frames === 60 && (median(works) > 2 || (gaps.length > 10 && median(gaps) > 25))) {
        try {
          sessionStorage.setItem(SLOW_KEY, 'slow');
        } catch {
          // Storage refused: the crawler still leaves this page.
        }
        teardown();
        return;
      }
    }
    if (mode === 'out' || (settled(c) && !then)) {
      if (mode !== 'out') mode = 'stand';
      last = 0;
      return;
    }
    // A walk begun inside this frame has asked for the next one already: never two at once.
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const back = (side: -1 | 1) => {
    returning = false;
    moved = performance.now();
    build();
    const v = space.view;
    const inside = {
      x: side < 0 ? v.x + plan.reach * 2 : v.x + v.w - plan.reach * 2,
      y: clamp(c.y, band()),
    };
    enter(inside);
    const heading = side < 0 ? 0 : Math.PI;
    // When no walk in is taken it stays out, and the next pointer move brings it in (R20).
    go(
      walkTo(
        space,
        plan,
        c,
        standsNear(space, plan, inside, () => heading, plan.span),
      ),
      heading,
      null,
    );
  };

  const teardown = () => {
    halt();
    for (const id of timers.values()) clearTimeout(id);
    off.abort();
    observer.disconnect();
    watcher.disconnect();
    layer.remove();
  };

  // ---------- The reader ----------
  // P3 of the first review: a plan at most every 150 ms, and only when the pointer has moved 0.12
  // of a span since the last; the time spent planning counts in the slow device's rule.
  let followed = Number.NEGATIVE_INFINITY;
  let planned: Vec = { x: Number.POSITIVE_INFINITY, y: 0 };
  const replan = () => {
    if (!pointer) return;
    followed = performance.now();
    planned = pointer;
    timed(follow);
  };
  addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch' || frozen) return;
      moved = performance.now();
      pointer = local(e.clientX, e.clientY);
      cancel('rest', 'row');
      // Out with a timer that brings it back, it waits; out without one, this move brings it in.
      if (mode === 'out' && returning) return;
      // A new plan only once the pointer is 0.12 of a span from where the last one was made.
      if (Math.hypot(pointer.x - planned.x, pointer.y - planned.y) >= plan.span * 0.12) {
        const wait = 150 - (moved - followed);
        if (wait <= 0) replan();
        else later('follow', wait, replan);
      }
      const row = e.target instanceof Element ? e.target.closest(ROWS) : null;
      if (row) later('row', 600, () => timed(() => read(row)));
      else later('rest', 800, () => timed(rest));
    },
    on,
  );
  addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch') return;
      moved = performance.now();
      timed(() => scurry(local(e.clientX, e.clientY)));
    },
    on,
  );
  document.addEventListener(
    'pointerout',
    (e) => {
      if (!e.relatedTarget) halt();
    },
    on,
  );
  document.addEventListener('visibilitychange', () => document.hidden && halt(), on);
  addEventListener(
    'scroll',
    () => {
      frozen = true;
      halt();
      later('still', 200, () => {
        frozen = false;
        build();
      });
    },
    on,
  );
  const rebuild = () =>
    later('build', 200, () => {
      resize();
      paints();
      build();
      if (c && mode !== 'out' && !raf) draw();
    });
  addEventListener('resize', rebuild, on);
  document.fonts?.ready.then(rebuild).catch(() => {});
  const observer = new ResizeObserver(rebuild);
  observer.observe(main);
  // A change of theme draws it again in the new ink.
  const watcher = new MutationObserver(() => {
    paints();
    build();
    if (mode !== 'out') draw();
  });
  watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => e.matches && teardown(), on);

  // ---------- In it comes ----------
  // Out of sight, so its first follow brings it in at the side edge nearest the pointer (R20).
  pointer = local(clientX, clientY);
  follow();

  if (__PRIX_FIXTURES__) {
    // For the page driver of a sample build only (crawler-check.mjs); a production build drops it.
    (window as unknown as { __crawler: unknown }).__crawler = {
      state: () => {
        const box = main.getBoundingClientRect();
        return {
          mode,
          running: raf !== 0,
          x: c.x + box.left,
          y: c.y + box.top,
          glyphs:
            mode === 'out'
              ? []
              : shown.map((g) => {
                  const b = glyphBox(g);
                  return { ...b, x: b.x + box.left, y: b.y + box.top, ch: g.ch };
                }),
          dropped,
          built,
          drawn,
          work,
          size,
          span: plan.span,
          font: plan.font,
          reads,
          stand: canStand(space, plan, c, c.heading),
        };
      },
      build: () => {
        build();
        return built;
      },
    };
  }
}
