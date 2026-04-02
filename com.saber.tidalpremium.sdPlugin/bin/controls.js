"use strict";

const { ACTIONS, RENDER } = require("./constants");

class Controls {
  constructor({ mediaSession, logger }) {
    this.mediaSession = mediaSession;
    this.logger = logger;
    this.volumeOverlays = new Map();
  }

  getOverlay(context, now = Date.now()) {
    const overlay = this.volumeOverlays.get(context);
    if (!overlay) {
      return null;
    }

    if (now >= overlay.expiresAt) {
      this.volumeOverlays.delete(context);
      return null;
    }

    const duration = overlay.expiresAt - overlay.startedAt;
    const elapsed = now - overlay.startedAt;
    const opacity = 1 - Math.min(1, elapsed / duration);
    return { ...overlay, opacity };
  }

  setVolumeOverlay(context, volumeState) {
    const now = Date.now();
    const overlay = {
      value: Math.round(volumeState.value),
      muted: Boolean(volumeState.muted),
      source: volumeState.source,
      startedAt: now,
      expiresAt: now + RENDER.VOLUME_OVERLAY_MS,
    };

    this.volumeOverlays.set(context, overlay);
    return overlay;
  }

  async handleTransportAction(action) {
    switch (action) {
      case ACTIONS.NOW_PLAYING:
      case ACTIONS.PLAY_PAUSE:
        await this.mediaSession.togglePlayPause();
        return;
      case ACTIONS.NEXT:
        await this.mediaSession.nextTrack();
        return;
      case ACTIONS.PREVIOUS:
        await this.mediaSession.previousTrack();
        return;
      default:
        return;
    }
  }

  async onKeyDown(message) {
    await this.handleTransportAction(message.action);
  }

  async onDialRotate(message) {
    if (message.action !== ACTIONS.VOLUME) {
      return null;
    }

    const ticks = Number(message.payload?.ticks || 0);
    if (!ticks) {
      return null;
    }

    const step = message.payload?.pressed ? 4 : 2;
    const result = await this.mediaSession.changeVolume(ticks * step);
    this.logger.info("volume-adjusted", {
      context: message.context,
      ticks,
      target: result.source,
      volume: result.value,
      muted: result.muted,
    });
    return this.setVolumeOverlay(message.context, result);
  }

  async onDialUp(message) {
    if (message.action === ACTIONS.VOLUME) {
      const result = await this.mediaSession.toggleMute();
      this.logger.info("volume-muted-toggled", {
        context: message.context,
        target: result.source,
        volume: result.value,
        muted: result.muted,
      });
      return this.setVolumeOverlay(message.context, result);
    }

    if (message.action === ACTIONS.NOW_PLAYING) {
      await this.mediaSession.nextTrack();
      return null;
    }

    await this.handleTransportAction(message.action);
    return null;
  }

  async onTouchTap(message) {
    if (message.action === ACTIONS.NOW_PLAYING) {
      await this.mediaSession.togglePlayPause();
      return null;
    }

    await this.handleTransportAction(message.action);
    return null;
  }
}

module.exports = {
  Controls,
};
