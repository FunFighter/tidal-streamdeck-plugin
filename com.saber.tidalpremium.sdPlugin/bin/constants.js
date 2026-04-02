"use strict";

const ACTIONS = {
  NOW_PLAYING: "com.saber.tidalpremium.nowplaying",
  PLAY_PAUSE: "com.saber.tidalpremium.playpause",
  NEXT: "com.saber.tidalpremium.next",
  PREVIOUS: "com.saber.tidalpremium.previous",
  VOLUME: "com.saber.tidalpremium.volume",
};

const RENDER = {
  KEY_SIZE: 144,
  ENCODER_ICON_SIZE: 144,
  LOOP_MS: 250,
  POLL_MS: 1000,
  WARMUP_DEBOUNCE_MS: 3000,
  WARMUP_DELAYS_MS: [150, 450, 900, 1600, 2600],
  VOLUME_OVERLAY_MS: 1600,
};

module.exports = {
  ACTIONS,
  RENDER,
};
