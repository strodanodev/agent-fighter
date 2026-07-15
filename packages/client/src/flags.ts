/**
 * Animated country flags for the character-select corners.
 *
 * PLAYER flag  — derived from the DEVICE region (timezone first, then locale).
 *   This is client-only and needs no permission prompt or network round-trip,
 *   unlike navigator.geolocation (which yields raw coordinates that would then
 *   need an external reverse-geocode — off the table for an offline, no-CDN
 *   bundle and a needless privacy ask on a menu). If no region can be inferred
 *   the flag falls back to WE ARE ANONYMOUS.
 * OPPONENT flag — resolved from auth/Supabase user metadata via
 *   `resolveOpponentCountry()`. No auth layer exists yet, so it returns null
 *   (→ ANONYMOUS) today; when Supabase lands, point that one function at
 *   `user.user_metadata.country` (or set it explicitly with
 *   `setOpponentCountry`). Everything downstream already works.
 *
 * Rendering is 100% procedural on the 2D canvas — no image assets, no CDN.
 * Each flag is drawn once to an offscreen canvas (a declarative FlagSpec
 * interpreter) and then blitted as a WAVING CLOTH: vertical slices offset by a
 * travelling sine, with fold shading, a hoist pole, and a one-shot linear
 * wipe-in when it first appears. DEPENDENCY-FREE LEAF (imports nothing from the
 * client) so it can sit before ui.ts in the bundle.
 */

const FLAG_FONT = "'AgentDisplay', Impact, 'Arial Black', sans-serif";

// --------------------------------------------------------------- flag artwork
type Overlay =
  | { t: 'disc'; c: string; cx: number; cy: number; r: number }
  | { t: 'triangleHoist'; c: string; w: number } // white triangle from the hoist
  | { t: 'star'; c: string; cx: number; cy: number; r: number; points?: number; rot?: number }
  | { t: 'phSun'; c: string } // Philippine sun + 3 stars inside the hoist triangle
  | { t: 'cross'; c: string; thick: number; cx?: number } // upright cross (cx shifts the vertical bar)
  | { t: 'saltire'; c: string; thick: number } // diagonal X
  | { t: 'usCanton' } // blue field + star grid, top-hoist
  | { t: 'chakra'; c: string; cx: number; cy: number; r: number }
  | { t: 'rect'; c: string; x: number; y: number; w: number; h: number };

interface FlagSpec {
  name: string;
  bg?: string;
  h?: string[]; // equal horizontal stripes, top → bottom
  v?: string[]; // equal vertical stripes, hoist → fly
  overlays?: Overlay[];
}

// All coordinates below are FRACTIONS of the flag's width/height.
const FLAGS: Record<string, FlagSpec> = {
  PH: {
    name: 'PHILIPPINES',
    h: ['#0038A8', '#CE1126'],
    overlays: [{ t: 'triangleHoist', c: '#FFFFFF', w: 0.42 }, { t: 'phSun', c: '#FCD116' }],
  },
  US: {
    name: 'UNITED STATES',
    h: ['#B22234', '#fff', '#B22234', '#fff', '#B22234', '#fff', '#B22234',
      '#fff', '#B22234', '#fff', '#B22234', '#fff', '#B22234'],
    overlays: [{ t: 'usCanton' }],
  },
  JP: { name: 'JAPAN', bg: '#fff', overlays: [{ t: 'disc', c: '#BC002D', cx: 0.5, cy: 0.5, r: 0.3 }] },
  CN: {
    name: 'CHINA', bg: '#DE2910',
    overlays: [
      { t: 'star', c: '#FFDE00', cx: 0.16, cy: 0.26, r: 0.14 },
      { t: 'star', c: '#FFDE00', cx: 0.32, cy: 0.14, r: 0.05 },
      { t: 'star', c: '#FFDE00', cx: 0.38, cy: 0.26, r: 0.05 },
      { t: 'star', c: '#FFDE00', cx: 0.38, cy: 0.42, r: 0.05 },
      { t: 'star', c: '#FFDE00', cx: 0.32, cy: 0.54, r: 0.05 },
    ],
  },
  KR: {
    name: 'KOREA', bg: '#fff',
    overlays: [
      { t: 'disc', c: '#CD2E3A', cx: 0.5, cy: 0.5, r: 0.2 }, // taeguk (top half red — simplified)
      { t: 'disc', c: '#0047A0', cx: 0.5, cy: 0.58, r: 0.1 },
      { t: 'disc', c: '#CD2E3A', cx: 0.5, cy: 0.42, r: 0.1 },
    ],
  },
  GB: {
    name: 'UNITED KINGDOM', bg: '#012169',
    overlays: [
      { t: 'saltire', c: '#FFFFFF', thick: 0.18 },
      { t: 'saltire', c: '#C8102E', thick: 0.08 },
      { t: 'cross', c: '#FFFFFF', thick: 0.22 },
      { t: 'cross', c: '#C8102E', thick: 0.12 },
    ],
  },
  IN: {
    name: 'INDIA', h: ['#FF9933', '#fff', '#138808'],
    overlays: [{ t: 'chakra', c: '#000080', cx: 0.5, cy: 0.5, r: 0.13 }],
  },
  VN: { name: 'VIETNAM', bg: '#DA251D', overlays: [{ t: 'star', c: '#FFFF00', cx: 0.5, cy: 0.5, r: 0.26 }] },
  FR: { name: 'FRANCE', v: ['#0055A4', '#fff', '#EF4135'] },
  IT: { name: 'ITALY', v: ['#009246', '#fff', '#CE2B37'] },
  IE: { name: 'IRELAND', v: ['#169B62', '#fff', '#FF883E'] },
  BE: { name: 'BELGIUM', v: ['#000000', '#FDDA24', '#EF3340'] },
  DE: { name: 'GERMANY', h: ['#000000', '#DD0000', '#FFCE00'] },
  ES: { name: 'SPAIN', h: ['#AA151B', '#F1BF00', '#F1BF00', '#AA151B'] },
  NL: { name: 'NETHERLANDS', h: ['#AE1C28', '#fff', '#21468B'] },
  RU: { name: 'RUSSIA', h: ['#fff', '#0039A6', '#D52B1E'] },
  ID: { name: 'INDONESIA', h: ['#FF0000', '#fff'] },
  PL: { name: 'POLAND', h: ['#fff', '#DC143C'] },
  UA: { name: 'UKRAINE', h: ['#0057B7', '#FFD700'] },
  TH: { name: 'THAILAND', h: ['#A51931', '#F4F5F8', '#2D2A4A', '#2D2A4A', '#F4F5F8', '#A51931'] },
  SG: {
    name: 'SINGAPORE', h: ['#EF3340', '#fff'],
    overlays: [{ t: 'disc', c: '#fff', cx: 0.2, cy: 0.25, r: 0.13 }, { t: 'disc', c: '#EF3340', cx: 0.24, cy: 0.25, r: 0.11 }],
  },
  MY: {
    name: 'MALAYSIA',
    h: ['#CC0001', '#fff', '#CC0001', '#fff', '#CC0001', '#fff', '#CC0001',
      '#fff', '#CC0001', '#fff', '#CC0001', '#fff', '#CC0001', '#fff'],
    overlays: [{ t: 'rect', c: '#010066', x: 0, y: 0, w: 0.5, h: 0.5 }],
  },
  BR: {
    name: 'BRAZIL', bg: '#009C3B',
    overlays: [{ t: 'disc', c: '#FFDF00', cx: 0.5, cy: 0.5, r: 0.28 }, { t: 'disc', c: '#002776', cx: 0.5, cy: 0.5, r: 0.16 }],
  },
  MX: { name: 'MEXICO', v: ['#006847', '#fff', '#CE1126'], overlays: [{ t: 'disc', c: '#8B5A2B', cx: 0.5, cy: 0.5, r: 0.08 }] },
  CA: { name: 'CANADA', v: ['#FF0000', '#fff', '#FF0000'], overlays: [{ t: 'star', c: '#FF0000', cx: 0.5, cy: 0.5, r: 0.16, points: 6 }] },
  AU: {
    name: 'AUSTRALIA', bg: '#00008B',
    overlays: [
      { t: 'rect', c: '#012169', x: 0, y: 0, w: 0.4, h: 0.5 },
      { t: 'cross', c: '#fff', thick: 0.06, cx: 0.2 },
      { t: 'star', c: '#fff', cx: 0.2, cy: 0.75, r: 0.09, points: 7 },
      { t: 'star', c: '#fff', cx: 0.72, cy: 0.4, r: 0.06 },
      { t: 'star', c: '#fff', cx: 0.82, cy: 0.62, r: 0.06 },
    ],
  },
  SE: { name: 'SWEDEN', bg: '#006AA7', overlays: [{ t: 'cross', c: '#FECC00', thick: 0.14, cx: 0.32 }] },
};

// The fallback "no location" flag: a dark banner with a theatrical mask, so a
// player with no resolvable region still reads as a deliberate faction, not a
// bug. Rendered by a dedicated routine (masks don't fit the stripe interpreter).
const ANON_KEY = '__ANON__';

const hexToRgb = (hex: string): [number, number, number] => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const drawStarShape = (
  ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, points: number, rot: number, color: string,
): void => {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = rot + (Math.PI * i) / points;
    const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
};

/** Paint a FlagSpec into a W×H context (fractional coords → pixels). */
const paintSpec = (ctx: CanvasRenderingContext2D, W: number, H: number, spec: FlagSpec): void => {
  if (spec.bg) { ctx.fillStyle = spec.bg; ctx.fillRect(0, 0, W, H); }
  if (spec.h) {
    const bh = H / spec.h.length;
    spec.h.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(0, Math.round(i * bh), W, Math.ceil(bh) + 1); });
  }
  if (spec.v) {
    const bw = W / spec.v.length;
    spec.v.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(Math.round(i * bw), 0, Math.ceil(bw) + 1, H); });
  }
  for (const o of spec.overlays ?? []) {
    switch (o.t) {
      case 'disc':
        ctx.fillStyle = o.c;
        ctx.beginPath(); ctx.arc(o.cx * W, o.cy * H, o.r * H, 0, Math.PI * 2); ctx.fill();
        break;
      case 'rect':
        ctx.fillStyle = o.c; ctx.fillRect(o.x * W, o.y * H, o.w * W, o.h * H);
        break;
      case 'triangleHoist':
        ctx.fillStyle = o.c;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(o.w * W, H / 2); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
        break;
      case 'star':
        drawStarShape(ctx, o.cx * W, o.cy * H, o.r * H, o.points ?? 5, o.rot ?? -Math.PI / 2, o.c);
        break;
      case 'cross':
        ctx.fillStyle = o.c;
        ctx.fillRect(0, H / 2 - (o.thick * H) / 2, W, o.thick * H); // horizontal
        ctx.fillRect((o.cx ?? 0.5) * W - (o.thick * W) / 2, 0, o.thick * W, H); // vertical
        break;
      case 'saltire': {
        ctx.save();
        ctx.strokeStyle = o.c; ctx.lineWidth = o.thick * H;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W, H); ctx.moveTo(W, 0); ctx.lineTo(0, H); ctx.stroke();
        ctx.restore();
        break;
      }
      case 'chakra': {
        const x = o.cx * W, y = o.cy * H, r = o.r * H;
        ctx.strokeStyle = o.c; ctx.lineWidth = Math.max(1, r * 0.12);
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
        for (let i = 0; i < 24; i++) {
          const a = (Math.PI * 2 * i) / 24;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); ctx.stroke();
        }
        break;
      }
      case 'usCanton': {
        const cw = W * 0.4, chh = H * 0.54;
        ctx.fillStyle = '#3C3B6E'; ctx.fillRect(0, 0, cw, chh);
        ctx.fillStyle = '#fff';
        for (let ry = 0; ry < 5; ry++) {
          for (let rx = 0; rx < 6; rx++) {
            const sx = (cw / 6) * (rx + 0.5) + (ry % 2) * (cw / 12);
            if (sx > cw) continue;
            ctx.beginPath(); ctx.arc(sx, (chh / 5) * (ry + 0.5), Math.max(0.6, W * 0.012), 0, Math.PI * 2); ctx.fill();
          }
        }
        break;
      }
      case 'phSun': {
        const cx = W * 0.14, cy = H * 0.5, r = H * 0.12;
        ctx.fillStyle = o.c;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = o.c; ctx.lineWidth = Math.max(1, r * 0.18);
        for (let i = 0; i < 8; i++) {
          const a = (Math.PI * 2 * i) / 8;
          ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          ctx.lineTo(cx + Math.cos(a) * r * 1.9, cy + Math.sin(a) * r * 1.9); ctx.stroke();
        }
        for (const [sx, sy] of [[0.05, 0.12], [0.05, 0.88], [0.34, 0.5]] as const) {
          drawStarShape(ctx, sx * W, sy * H, H * 0.05, 5, -Math.PI / 2, o.c);
        }
        break;
      }
    }
  }
};

/** The ANONYMOUS banner (mask + text) — its own routine (not a FlagSpec). */
const paintAnon = (ctx: CanvasRenderingContext2D, W: number, H: number): void => {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#161226'); g.addColorStop(1, '#0a0712');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // Faint circuit-ish diagonal hatch for texture.
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  for (let x = -H; x < W; x += 14) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + H, H); ctx.stroke();
  }
  // Stylized mask: pale face, hollow eyes, upturned moustache, goatee.
  const cx = W * 0.5, cy = H * 0.46, fw = W * 0.26, fh = H * 0.5;
  ctx.fillStyle = '#EDE6D6';
  ctx.beginPath();
  ctx.moveTo(cx, cy - fh * 0.5);
  ctx.quadraticCurveTo(cx + fw * 0.5, cy - fh * 0.3, cx + fw * 0.42, cy + fh * 0.1);
  ctx.quadraticCurveTo(cx + fw * 0.28, cy + fh * 0.5, cx, cy + fh * 0.55);
  ctx.quadraticCurveTo(cx - fw * 0.28, cy + fh * 0.5, cx - fw * 0.42, cy + fh * 0.1);
  ctx.quadraticCurveTo(cx - fw * 0.5, cy - fh * 0.3, cx, cy - fh * 0.5);
  ctx.fill();
  // Eyes.
  ctx.fillStyle = '#1a1526';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + s * fw * 0.2, cy - fh * 0.08, fw * 0.12, fh * 0.09, s * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  // Moustache (upturned) + goatee.
  ctx.strokeStyle = '#1a1526'; ctx.lineWidth = Math.max(1.5, W * 0.012); ctx.lineCap = 'round';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + fh * 0.14);
    ctx.quadraticCurveTo(cx + s * fw * 0.28, cy + fh * 0.18, cx + s * fw * 0.34, cy + fh * 0.02);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx, cy + fh * 0.2); ctx.lineTo(cx, cy + fh * 0.4); ctx.stroke();
  // Smile.
  ctx.beginPath();
  ctx.moveTo(cx - fw * 0.16, cy + fh * 0.2);
  ctx.quadraticCurveTo(cx, cy + fh * 0.32, cx + fw * 0.16, cy + fh * 0.2);
  ctx.stroke();
};

// -------------------------------------------------------- offscreen flag cache
const FW = 192, FH = 120;
const flagCanvasCache = new Map<string, HTMLCanvasElement>();

const flagCanvas = (key: string): HTMLCanvasElement => {
  let c = flagCanvasCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = FW; c.height = FH;
  const cx = c.getContext('2d')!;
  if (key === ANON_KEY) paintAnon(cx, FW, FH);
  else paintSpec(cx, FW, FH, FLAGS[key]!);
  flagCanvasCache.set(key, c);
  return c;
};

// A PORTRAIT version for the hanging medieval banner. Country flags are the
// landscape design rotated 90° (hoist → top), which is exactly how vertical
// "Hochformat" flags are hung. The ANONYMOUS mask is painted upright directly
// (rotating a face would tip it on its side).
const BW = 120, BH = 260;
const bannerCanvasCache = new Map<string, HTMLCanvasElement>();

const bannerCanvas = (key: string): HTMLCanvasElement => {
  let c = bannerCanvasCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = BW; c.height = BH;
  const cx = c.getContext('2d')!;
  if (key === ANON_KEY) {
    paintAnon(cx, BW, BH);
  } else {
    const src = flagCanvas(key);
    cx.save();
    cx.translate(BW / 2, BH / 2);
    cx.rotate(Math.PI / 2); // 90° clockwise → hoist edge lands at the top
    cx.drawImage(src, -BH / 2, -BW / 2, BH, BW);
    cx.restore();
  }
  bannerCanvasCache.set(key, c);
  return c;
};

const flagName = (key: string | null): string =>
  key && key !== ANON_KEY && FLAGS[key] ? FLAGS[key]!.name : 'WE ARE ANONYMOUS';

// ---------------------------------------------------------- country detection
// A compact timezone → ISO-3166-1 map. The device's timezone tracks physical
// location better than its UI language, so it's tried first.
const TZ_COUNTRY: Record<string, string> = {
  'Asia/Manila': 'PH', 'Asia/Tokyo': 'JP', 'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'CN',
  'Asia/Seoul': 'KR', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Jakarta': 'ID',
  'Asia/Bangkok': 'TH', 'Asia/Ho_Chi_Minh': 'VN', 'Asia/Saigon': 'VN', 'Asia/Singapore': 'SG',
  'Asia/Kuala_Lumpur': 'MY', 'Asia/Dubai': 'AE', 'Asia/Karachi': 'PK',
  'Europe/London': 'GB', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Dublin': 'IE',
  'Europe/Moscow': 'RU', 'Europe/Kyiv': 'UA', 'Europe/Kiev': 'UA', 'Europe/Warsaw': 'PL',
  'Europe/Stockholm': 'SE', 'Europe/Lisbon': 'PT',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US',
  'America/Phoenix': 'US', 'America/Anchorage': 'US', 'Pacific/Honolulu': 'US',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Perth': 'AU', 'Pacific/Auckland': 'NZ',
};

/** Best-effort ISO country from the device (timezone, then locale). Null if unknown. */
export const detectDeviceCountry = (): string | null => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && TZ_COUNTRY[tz]) return TZ_COUNTRY[tz]!;
  } catch { /* Intl unavailable — fall through */ }
  // Locale region, e.g. "en-PH" → "PH".
  const langs = [navigator.language, ...(navigator.languages ?? [])];
  for (const l of langs) {
    const m = /[-_]([A-Za-z]{2})$/.exec(l ?? '');
    if (m) return m[1]!.toUpperCase();
  }
  return null;
};

/**
 * Opponent region from auth/Supabase user metadata. No auth layer exists yet,
 * so this reads a conventional global that future auth code can populate
 * (`globalThis.__afOpponent = { country: 'JP' }`) and otherwise returns null
 * (→ ANONYMOUS). When Supabase lands, resolve `user.user_metadata.country`
 * here (or call setOpponentCountry after sign-in).
 */
export const resolveOpponentCountry = (): string | null => {
  const meta = (globalThis as { __afOpponent?: { country?: string } }).__afOpponent;
  const c = meta?.country;
  return c && (c === '' ? null : c.toUpperCase()) || null;
};

// ------------------------------------------------------------ resolved state
// side 0 = player (device), side 1 = opponent (auth). null country → ANONYMOUS.
// `override === undefined` means "auto-resolve"; an explicit set (incl. null)
// sticks and wins over auto-resolution.
let playerOverride: string | null | undefined;
let opponentOverride: string | null | undefined;
let detectedPlayer: string | null | undefined; // device detection, cached once
const revealAge: [number, number] = [0, 0]; // frames since each side's current flag appeared
const shownKey: [string, string] = ['', '']; // last drawn key per side — detects changes → replays wipe

const keyFor = (side: 0 | 1): string => {
  let c: string | null;
  if (side === 0) {
    if (playerOverride !== undefined) c = playerOverride;
    else { if (detectedPlayer === undefined) detectedPlayer = detectDeviceCountry(); c = detectedPlayer; }
  } else {
    c = opponentOverride !== undefined ? opponentOverride : resolveOpponentCountry();
  }
  return c && (FLAGS[c] || c === ANON_KEY) ? c : ANON_KEY;
};

/** Manual overrides (testing, or wiring real data in). Pass null to force ANONYMOUS. */
export const setPlayerCountry = (c: string | null): void => { playerOverride = c; };
export const setOpponentCountry = (c: string | null): void => { opponentOverride = c; };

// ------------------------------------------------------------------- drawing
/**
 * Draw the animated flag for `side` as a MEDIEVAL HANGING BANNER filling the
 * box (x,y,w,h): a crossbar with finials at the top, the cloth hanging
 * straight down (portrait, filling the tall corner), rippling side-to-side
 * with a travelling wave, tapering to a point at the bottom. A one-shot
 * top→down wipe-in plays when it first appears. `mirror` just flips the sway
 * direction so the two corners breathe in opposition.
 */
export const drawFlag = (
  ctx: CanvasRenderingContext2D, side: 0 | 1,
  x: number, y: number, w: number, h: number, tick: number, mirror = false,
): void => {
  const key = keyFor(side);
  if (key !== shownKey[side]) { shownKey[side] = key; revealAge[side] = 0; }
  const reveal = Math.min(1, revealAge[side] / 30);
  revealAge[side]++;

  const banner = bannerCanvas(key);
  const name = flagName(key);
  const cxMid = x + w / 2;

  // The faction / country name rides across the very top; the crossbar and the
  // long cloth take everything below it.
  ctx.save();
  ctx.font = `700 ${name.length > 13 ? 10 : 13}px ${FLAG_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = reveal;
  ctx.fillStyle = '#000000aa'; ctx.fillText(name, cxMid + 1, y + 12);
  ctx.fillStyle = key === ANON_KEY ? '#c9c4ff' : '#ffe9b0'; ctx.fillText(name, cxMid, y + 11);
  ctx.restore();

  const clothW = Math.min(w - 8, 104);
  const clothX0 = cxMid - clothW / 2;
  const barY = y + 20;
  const clothTop = barY + 6;
  const clothH = Math.max(120, y + h - clothTop - 4);

  // Crossbar with metallic sheen + two finial knobs, plus short hanging cords
  // down to the banner's top corners.
  const barX0 = clothX0 - 12, barX1 = clothX0 + clothW + 12;
  const bg = ctx.createLinearGradient(0, barY, 0, barY + 6);
  bg.addColorStop(0, '#e8ce80'); bg.addColorStop(0.5, '#a97b2e'); bg.addColorStop(1, '#6b4c17');
  ctx.fillStyle = bg;
  ctx.fillRect(barX0, barY, barX1 - barX0, 6);
  ctx.fillStyle = '#f0d27a';
  for (const bx of [barX0, barX1]) { ctx.beginPath(); ctx.arc(bx, barY + 3, 4.5, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = '#00000055'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(clothX0 + 2, barY + 5); ctx.lineTo(clothX0 + 2, clothTop);
  ctx.moveTo(clothX0 + clothW - 2, barY + 5); ctx.lineTo(clothX0 + clothW - 2, clothTop);
  ctx.stroke();

  // Hanging cloth: horizontal slices, each swayed by a wave that travels DOWN
  // (amplitude grows toward the free bottom), shaded to read as folds, and the
  // last stretch tapered to a central point (the pennant tail).
  const rows = Math.round(clothH / 3);
  const rowH = clothH / rows;
  const swayDir = mirror ? -1 : 1;
  const taperStart = 0.82;
  for (let r = 0; r < rows; r++) {
    const rt = r / (rows - 1); // 0 at crossbar → 1 at the tail tip
    if (rt > reveal) break; // top→down wipe-in
    const phase = tick * 0.11 - rt * 3.2;
    const taperK = rt <= taperStart ? 1 : Math.max(0, (1 - rt) / (1 - taperStart));
    const drawW = clothW * (rt <= taperStart ? 1 : taperK);
    const amp = clothW * 0.14 * rt * (rt <= taperStart ? 1 : taperK);
    const offX = Math.sin(phase) * amp * swayDir;
    const dstX = clothX0 + (clothW - drawW) / 2 + offX;
    const dstY = clothTop + r * rowH;
    ctx.drawImage(banner, 0, rt * (BH - 1), BW, BH / rows + 1, dstX, dstY, drawW, rowH + 1);
    const shade = Math.sin(phase);
    ctx.fillStyle = shade < 0 ? `rgba(0,0,0,${-shade * 0.3})` : `rgba(255,255,255,${shade * 0.12})`;
    ctx.fillRect(dstX, dstY, drawW, rowH + 1);
  }
};

// Console hooks: preview any flag without changing device settings.
Object.assign(globalThis, {
  afSetPlayerCountry: (c: string | null) => { setPlayerCountry(c); },
  afSetOpponentCountry: (c: string | null) => { setOpponentCountry(c); },
  afDetectCountry: () => detectDeviceCountry(),
});
