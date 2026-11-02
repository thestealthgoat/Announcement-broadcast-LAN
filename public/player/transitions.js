// Every transition, in one place, for the TV player and the admin preview. The server loads this
// same file through server/transitions.js. Deliberately ES5 with no build step, like player.js.
//
// A transition is named by a string:
//   cut           the new item appears at once
//   fade          the new item fades in over the old one
//   slide         the new item comes in from the right as the old one leaves to the left. This is
//                 the original transition from 1.0 and never changes. It has no direction choice.
//   push-<dir>    both items move together, in any of four directions. push-left has the same
//                 motion as slide
//   wipe-<dir>    the old item stays still while an edge moving in that direction reveals the new one
//   zoom          the new item grows into place and fades in over the old one
//
// Only opacity, transform, and clip-path are ever animated. Nothing depends on transitionend,
// which old TVs can miss: begin() says how long the transition takes, and the caller uses a timer.
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) module.exports = factory();
  else root.SignageTransitions = factory();
})(this, function () {
  'use strict';

  var DEFAULT_STYLE = 'fade';
  var DEFAULT_MS = 700; // what every transition took before speeds existed
  var MIN_MS = 200;
  var MAX_MS = 2000;
  var SPEEDS = { fast: 350, normal: DEFAULT_MS, slow: 1400 };
  var DIRECTIONS = ['left', 'right', 'up', 'down'];

  // For each direction: where a pushed item starts and leaves, and the clip that hides a wiped one.
  var MOVES = {
    left: { start: 'translateX(100%)', end: 'translateX(0)', leave: 'translateX(-100%)', hidden: 'inset(0 0 0 100%)' },
    right: { start: 'translateX(-100%)', end: 'translateX(0)', leave: 'translateX(100%)', hidden: 'inset(0 100% 0 0)' },
    up: { start: 'translateY(100%)', end: 'translateY(0)', leave: 'translateY(-100%)', hidden: 'inset(100% 0 0 0)' },
    down: { start: 'translateY(-100%)', end: 'translateY(0)', leave: 'translateY(100%)', hidden: 'inset(0 0 100% 0)' }
  };

  // from and to style the incoming layer, out styles the outgoing one. cut has no definition.
  var DEFINITIONS = {
    fade: { from: { opacity: '0' }, to: { opacity: '1' } },
    slide: { from: { transform: MOVES.left.start }, to: { transform: MOVES.left.end }, out: { transform: MOVES.left.leave } },
    zoom: { from: { transform: 'scale(0.7)', opacity: '0' }, to: { transform: 'scale(1)', opacity: '1' } }
  };

  (function () {
    for (var i = 0; i < DIRECTIONS.length; i++) {
      var move = MOVES[DIRECTIONS[i]];
      DEFINITIONS['push-' + DIRECTIONS[i]] = { from: { transform: move.start }, to: { transform: move.end }, out: { transform: move.leave } };
      DEFINITIONS['wipe-' + DIRECTIONS[i]] = { from: { clipPath: move.hidden }, to: { clipPath: 'inset(0 0 0 0)' } };
    }
  })();

  // Old browsers only animate the prefixed name, and newer ones treat it as the same property.
  var CSS_NAMES = { opacity: ['opacity'], transform: ['-webkit-transform', 'transform'], clipPath: ['-webkit-clip-path', 'clip-path'] };
  // A value each property must accept for that kind of transition to work here.
  var PROBES = { transform: 'translateX(0)', clipPath: 'inset(0 0 0 0)' };

  function has(object, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);
  }

  function isValid(style) {
    return style === 'cut' || has(DEFINITIONS, style);
  }

  function isValidMs(ms) {
    return typeof ms === 'number' && Math.floor(ms) === ms && ms >= MIN_MS && ms <= MAX_MS;
  }

  // The name for a stored duration, or null if it has none.
  function speedName(ms) {
    for (var name in SPEEDS) {
      if (has(SPEEDS, name) && SPEEDS[name] === ms) return name;
    }
    return null;
  }

  // What actually plays: the item's own setting, else its channel's default, else the original
  // transition column. Style and speed are worked out separately, so an item can change just one.
  function resolve(item, channel, legacy) {
    var own = item || {};
    var inherited = channel || {};
    var style = DEFAULT_STYLE;
    if (isValid(own.style)) style = own.style;
    else if (isValid(inherited.style)) style = inherited.style;
    else if (isValid(legacy)) style = legacy;
    var ms = DEFAULT_MS;
    if (isValidMs(own.ms)) ms = own.ms;
    else if (isValidMs(inherited.ms)) ms = inherited.ms;
    return { style: style, ms: ms };
  }

  function capitalized(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  function setStyle(el, prop, value) {
    el.style[prop] = value;
    el.style['webkit' + capitalized(prop)] = value;
  }

  function applyStyles(el, styles) {
    for (var prop in styles) {
      if (!has(styles, prop)) continue;
      if (prop === 'opacity') el.style.opacity = styles[prop];
      else setStyle(el, prop, styles[prop]);
    }
  }

  var accepted = {};

  // A browser drops a value it can't use, so a value that reads back is one it understood. This
  // also catches browsers that know clip-path but only for SVG references.
  function accepts(prop) {
    if (!has(accepted, prop)) {
      var probe = document.createElement('div');
      setStyle(probe, prop, PROBES[prop]);
      accepted[prop] = !!(probe.style[prop] || probe.style['webkit' + capitalized(prop)]);
    }
    return accepted[prop];
  }

  function canPlay(definition) {
    var styles = definition.from;
    for (var prop in styles) {
      if (has(styles, prop) && has(PROBES, prop) && !accepts(prop)) return false;
    }
    return true;
  }

  // The transition this browser will really show: unknown ones and ones it can't do become a fade.
  function playable(style) {
    if (style === 'cut') return 'cut';
    return has(DEFINITIONS, style) && canPlay(DEFINITIONS[style]) ? style : DEFAULT_STYLE;
  }

  function transitionValue(styles, ms) {
    var parts = [];
    for (var prop in styles) {
      if (!has(styles, prop)) continue;
      for (var i = 0; i < CSS_NAMES[prop].length; i++) parts.push(CSS_NAMES[prop][i] + ' ' + ms + 'ms ease');
    }
    return parts.join(', ');
  }

  // Starts a transition between two layers already on screen, with incoming stacked on top.
  // Returns how long it takes in milliseconds. 0 means it was a cut, so nothing is animating.
  function begin(incoming, outgoing, style, ms) {
    var name = playable(style);
    if (name === 'cut') return 0;
    var definition = DEFINITIONS[name];
    var duration = isValidMs(ms) ? ms : DEFAULT_MS;
    applyStyles(incoming, definition.from);
    void incoming.offsetWidth; // the start has to take effect, or there is nothing to animate from
    setStyle(incoming, 'transition', transitionValue(definition.to, duration));
    applyStyles(incoming, definition.to);
    if (definition.out) {
      setStyle(outgoing, 'transition', transitionValue(definition.out, duration));
      applyStyles(outgoing, definition.out);
    }
    return duration;
  }

  // Clears a finished transition from the layer left on screen. Video on some TVs plays
  // differently under a transform, even one that moves nothing.
  function settle(el) {
    setStyle(el, 'transition', '');
    setStyle(el, 'transform', '');
    setStyle(el, 'clipPath', '');
    el.style.opacity = '';
  }

  return {
    DEFAULT_STYLE: DEFAULT_STYLE,
    DEFAULT_MS: DEFAULT_MS,
    SPEEDS: SPEEDS,
    DIRECTIONS: DIRECTIONS,
    isValid: isValid,
    isValidMs: isValidMs,
    speedName: speedName,
    resolve: resolve,
    playable: playable,
    begin: begin,
    settle: settle
  };
});
