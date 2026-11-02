import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { httpError } from './auth.js';
import { parseWall } from './schedule.js';

// Same loading trick as server/schedule.js, so the allowed values have one home.
const file = fileURLToPath(new URL('../public/player/slide-render.js', import.meta.url));
const loaded = { exports: {} };
vm.compileFunction(fs.readFileSync(file, 'utf8'), ['module'], { filename: file })(loaded);
const { OPTIONS } = loaded.exports;

const HEX = /^#[0-9a-fA-F]{6}$/;
const IMAGE_ID = /^[A-Za-z0-9-]{1,64}$/;
const COUNTDOWN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

const FIELDS = new Set(['template', 'background', 'image', 'dim', 'textColor', 'accentColor', 'titleSize', 'bodySize', 'align', 'logo', 'countdown']);
const SIZE_NAMES = OPTIONS.sizes;

const refuse = (message) => {
  throw httpError(400, message);
};

const isPlain = (v) => Object.prototype.toString.call(v) === '[object Object]';

function hex(value, label) {
  if (typeof value !== 'string' || !HEX.test(value)) refuse(`${label} must be a color like #1f2937.`);
  return value.toLowerCase();
}

function oneOf(value, allowed, message) {
  if (!allowed.includes(value)) refuse(message);
  return value;
}

function background(value) {
  if (!isPlain(value)) refuse('The background could not be read.');
  const allowed = value.type === 'solid' ? ['type', 'color'] : value.type === 'gradient' ? ['type', 'from', 'to'] : null;
  if (!allowed) refuse('The background must be a color or a gradient.');
  if (Object.keys(value).some((k) => !allowed.includes(k))) refuse('The background could not be read.');
  if (value.type === 'solid') return { type: 'solid', color: hex(value.color, 'The background') };
  return { type: 'gradient', from: hex(value.from, 'The gradient start'), to: hex(value.to, 'The gradient end') };
}

function imageId(db, value) {
  const message = 'Choose a picture from the library for the background.';
  if (typeof value !== 'string' || !IMAGE_ID.test(value)) refuse(message);
  const media = db.get('SELECT type, status FROM media WHERE id = ?', value);
  if (!media || media.type !== 'image') refuse(message);
  if (media.status !== 'ready') refuse('That picture is not ready yet.');
  return value;
}

function countdown(value) {
  if (typeof value !== 'string' || !COUNTDOWN.test(value) || parseWall(value) === null) {
    refuse('The countdown needs a real date and time.');
  }
  return value;
}

// Checks a design sent by a browser and returns a clean copy, or null when it sets nothing.
// Only the listed fields and values get through, and no value is ever used as raw CSS.
export function validateStyle(db, input) {
  if (input === null) return null;
  if (!isPlain(input)) refuse('That slide design could not be read.');
  if (Object.keys(input).some((k) => !FIELDS.has(k))) refuse('That slide design has a setting this app does not recognize.');

  const out = {};
  const given = (key) => input[key] !== undefined && input[key] !== null;
  if (given('template')) {
    const id = input.template;
    if (!Number.isInteger(id) || !db.get('SELECT 1 AS x FROM slide_templates WHERE id = ?', id)) refuse('That template no longer exists.');
    out.template = id;
  }
  if (given('background')) out.background = background(input.background);
  if (given('image')) out.image = imageId(db, input.image);
  if (given('dim')) {
    const { dim } = input;
    if (typeof dim !== 'number' || !Number.isInteger(dim) || dim < 0 || dim > OPTIONS.maxDim) refuse(`Dimming must be between 0 and ${OPTIONS.maxDim}.`);
    out.dim = dim;
  }
  if (given('textColor')) out.textColor = hex(input.textColor, 'The text color');
  if (given('accentColor')) out.accentColor = hex(input.accentColor, 'The accent color');
  if (given('titleSize')) out.titleSize = oneOf(input.titleSize, SIZE_NAMES, 'Choose a title size from the list.');
  if (given('bodySize')) out.bodySize = oneOf(input.bodySize, SIZE_NAMES, 'Choose a message size from the list.');
  if (given('align')) out.align = oneOf(input.align, OPTIONS.align, 'Alignment must be left, center, or right.');
  if (given('logo')) out.logo = oneOf(input.logo, OPTIONS.logo, 'Choose a logo position from the list.');
  if (given('countdown')) out.countdown = countdown(input.countdown);
  return Object.keys(out).length ? out : null;
}

// What's stored, or null. A damaged value must never stop a TV from getting its slides.
export function parseStyle(json) {
  if (!json) return null;
  try {
    const style = JSON.parse(json);
    return isPlain(style) ? style : null;
  } catch {
    return null;
  }
}

// The style a TV receives. The picture's address is built here, from the library's own record,
// and left out when the picture has gone, so the slide falls back to its color.
export function resolveStyle(db, json) {
  const style = parseStyle(json);
  if (!style) return null;
  if (typeof style.image !== 'string') return style;
  const media = db.get("SELECT id, file FROM media WHERE id = ? AND type = 'image' AND status = 'ready'", style.image);
  return media?.file ? { ...style, imageUrl: `/media/${media.id}/${media.file}` } : style;
}

// Part of a slide's key, so a TV rebuilds a slide whose look changed, including when its picture goes away.
export const styleKey = (style) => createHash('sha1').update(JSON.stringify(style)).digest('hex').slice(0, 10);
