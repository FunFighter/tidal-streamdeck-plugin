"use strict";

const { createCanvas } = require("@napi-rs/canvas");
const { ACTIONS, RENDER } = require("./constants");

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function fillRoundRect(ctx, x, y, width, height, radius, color) {
  ctx.fillStyle = color;
  roundRectPath(ctx, x, y, width, height, radius);
  ctx.fill();
}

function strokeRoundRect(ctx, x, y, width, height, radius, color, lineWidth) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  roundRectPath(ctx, x, y, width, height, radius);
  ctx.stroke();
}

function easeInOutSine(progress) {
  return -(Math.cos(Math.PI * progress) - 1) / 2;
}

function canvasToDataUrl(canvas) {
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

class Renderer {
  constructor({ cache, logger, debug }) {
    this.cache = cache;
    this.logger = logger;
    this.debug = debug;
    this.marquees = new Map();
    this.stats = new Map();
  }

  updateStats(contextKey, now) {
    const stat = this.stats.get(contextKey) || {
      lastAt: now,
      fps: 0,
    };

    const delta = Math.max(1, now - stat.lastAt);
    stat.fps = Number((1000 / delta).toFixed(1));
    stat.lastAt = now;
    this.stats.set(contextKey, stat);
    return stat;
  }

  computeMarqueeState(key, text, availableWidth, font, now) {
    const state = this.marquees.get(key) || {
      text: "",
      startedAt: now,
      overflow: 0,
      shouldScroll: false,
    };

    if (state.text !== text) {
      state.text = text;
      state.startedAt = now;
    }

    state.font = font;
    state.availableWidth = availableWidth;
    this.marquees.set(key, state);
    return state;
  }

  drawMarquee(ctx, key, text, x, y, width, now, font, color) {
    ctx.save();
    ctx.font = font;
    const measure = ctx.measureText(text);
    const overflow = Math.max(0, measure.width - width);
    const state = this.computeMarqueeState(key, text, width, font, now);
    state.overflow = overflow;
    state.shouldScroll = overflow > 2;

    let offset = 0;
    if (state.shouldScroll) {
      const holdStartMs = 700;
      const travelMs = Math.max(2400, overflow * 18);
      const holdEndMs = 650;
      const cycleMs = holdStartMs + travelMs + holdEndMs;
      const cyclePos = Math.max(0, (now - state.startedAt) % cycleMs);

      if (cyclePos <= holdStartMs) {
        offset = 0;
      } else if (cyclePos >= holdStartMs + travelMs) {
        offset = overflow;
      } else {
        const travelPos = (cyclePos - holdStartMs) / travelMs;
        offset = easeInOutSine(travelPos) * overflow;
      }
    }

    ctx.beginPath();
    ctx.rect(x, y - 18, width, 24);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x - offset, y);
    ctx.restore();

    return {
      offset: Math.round(offset * 2) / 2,
      shouldScroll: state.shouldScroll,
    };
  }

  drawTransportIcon(ctx, kind, x, y, size, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    switch (kind) {
      case "play":
        ctx.beginPath();
        ctx.moveTo(-size * 0.28, -size * 0.34);
        ctx.lineTo(size * 0.34, 0);
        ctx.lineTo(-size * 0.28, size * 0.34);
        ctx.closePath();
        ctx.fill();
        break;
      case "pause":
        fillRoundRect(ctx, -size * 0.24, -size * 0.34, size * 0.18, size * 0.68, size * 0.08, color);
        fillRoundRect(ctx, size * 0.06, -size * 0.34, size * 0.18, size * 0.68, size * 0.08, color);
        break;
      case "next":
        ctx.beginPath();
        ctx.moveTo(-size * 0.38, -size * 0.3);
        ctx.lineTo(-size * 0.02, 0);
        ctx.lineTo(-size * 0.38, size * 0.3);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-size * 0.02, -size * 0.3);
        ctx.lineTo(size * 0.34, 0);
        ctx.lineTo(-size * 0.02, size * 0.3);
        ctx.closePath();
        ctx.fill();
        fillRoundRect(ctx, size * 0.34, -size * 0.34, size * 0.08, size * 0.68, size * 0.03, color);
        break;
      case "previous":
        ctx.beginPath();
        ctx.moveTo(size * 0.38, -size * 0.3);
        ctx.lineTo(size * 0.02, 0);
        ctx.lineTo(size * 0.38, size * 0.3);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(size * 0.02, -size * 0.3);
        ctx.lineTo(-size * 0.34, 0);
        ctx.lineTo(size * 0.02, size * 0.3);
        ctx.closePath();
        ctx.fill();
        fillRoundRect(ctx, -size * 0.42, -size * 0.34, size * 0.08, size * 0.68, size * 0.03, color);
        break;
      case "speaker":
        ctx.beginPath();
        ctx.moveTo(-size * 0.34, size * 0.18);
        ctx.lineTo(-size * 0.34, -size * 0.18);
        ctx.lineTo(-size * 0.14, -size * 0.18);
        ctx.lineTo(size * 0.04, -size * 0.36);
        ctx.lineTo(size * 0.04, size * 0.36);
        ctx.lineTo(-size * 0.14, size * 0.18);
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = Math.max(3, size * 0.08);
        ctx.beginPath();
        ctx.arc(size * 0.02, 0, size * 0.24, -Math.PI / 4, Math.PI / 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(size * 0.04, 0, size * 0.38, -Math.PI / 4, Math.PI / 4);
        ctx.stroke();
        break;
      default:
        this.drawTransportIcon(ctx, "play", 0, 0, size, color);
        break;
    }

    ctx.restore();
  }

  drawPlaceholderArt(ctx, width, height, title) {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#091426");
    gradient.addColorStop(1, "#0b6cf4");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.globalAlpha = 0.22;
    for (let band = 0; band < 5; band += 1) {
      fillRoundRect(ctx, 14 + band * 8, 18 + band * 10, width - 28 - band * 16, 20, 10, "#9fdfff");
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "600 16px Segoe UI";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(title || "TIDAL", width / 2, height / 2 + 28);
  }

  drawArtwork(ctx, image, width, height) {
    if (!image) {
      this.drawPlaceholderArt(ctx, width, height, "TIDAL");
      return;
    }

    const sourceWidth = image.width || width;
    const sourceHeight = image.height || height;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    const drawX = (width - drawWidth) / 2;
    const drawY = (height - drawHeight) / 2;
    ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
  }

  renderNowPlayingTouchBackground(snapshot, artwork) {
    const canvas = createCanvas(200, 100);
    const ctx = canvas.getContext("2d");
    this.drawArtwork(ctx, artwork?.image, 200, 100);

    const overlay = ctx.createLinearGradient(0, 0, 200, 100);
    overlay.addColorStop(0, "rgba(5,10,18,0.18)");
    overlay.addColorStop(0.65, "rgba(5,10,18,0.46)");
    overlay.addColorStop(1, "rgba(5,10,18,0.82)");
    ctx.fillStyle = overlay;
    ctx.fillRect(0, 0, 200, 100);
    fillRoundRect(ctx, 150, 10, 36, 24, 10, "rgba(0,0,0,0.42)");
    this.drawTransportIcon(ctx, snapshot.isPlaying ? "pause" : "play", 168, 22, 16, "#ffffff");
    return canvasToDataUrl(canvas);
  }

  renderTransportTouchBackground(snapshot, kind, label, preview, previewArtwork) {
    const canvas = createCanvas(200, 100);
    const ctx = canvas.getContext("2d");

    if (previewArtwork?.image) {
      this.drawArtwork(ctx, previewArtwork.image, 200, 100);
    } else if (preview) {
      this.drawPlaceholderArt(ctx, 200, 100, preview.title || label);
    } else {
      const background = ctx.createLinearGradient(0, 0, 200, 100);
      background.addColorStop(0, snapshot.active ? "#0f1a32" : "#10141f");
      background.addColorStop(1, snapshot.active ? "#0b6cf4" : "#1b2437");
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, 200, 100);
    }

    const overlay = ctx.createLinearGradient(0, 0, 0, 100);
    overlay.addColorStop(0, "rgba(5,10,18,0.18)");
    overlay.addColorStop(0.55, "rgba(5,10,18,0.34)");
    overlay.addColorStop(1, "rgba(5,10,18,0.86)");
    ctx.fillStyle = overlay;
    ctx.fillRect(0, 0, 200, 100);

    fillRoundRect(ctx, 12, 10, 78, 18, 9, "rgba(0,0,0,0.42)");
    fillRoundRect(ctx, 160, 10, 28, 24, 10, "rgba(0,0,0,0.42)");
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 11px Segoe UI";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label.toUpperCase(), 51, 19);
    this.drawTransportIcon(ctx, kind, 174, 22, 15, "#ffffff");

    return canvasToDataUrl(canvas);
  }

  drawPreviewText(ctx, x, y, width, title, subtitle, now, keyPrefix) {
    ctx.save();
    ctx.font = "700 12px Segoe UI";
    this.drawMarquee(ctx, `${keyPrefix}:title`, title, x, y, width, now, "700 12px Segoe UI", "#ffffff");
    ctx.font = "600 10px Segoe UI";
    this.drawMarquee(ctx, `${keyPrefix}:subtitle`, subtitle, x, y + 14, width, now, "600 10px Segoe UI", "rgba(225,233,241,0.86)");
    ctx.restore();
  }

  drawWaveform(ctx, snapshot, now, opacity = 0.38, bounds = null) {
    if (!snapshot.hasMedia) {
      return;
    }

    const area = bounds || {
      x: 12,
      y: 72,
      width: RENDER.KEY_SIZE - 24,
      height: 46,
      bars: 16,
    };
    const height = area.height;
    const x = area.x;
    const y = area.y;
    const bars = area.bars || 16;
    const gap = 3;
    const barWidth = Math.max(3, Math.floor((area.width - ((bars - 1) * gap)) / bars));
    const phaseTime = snapshot.isPlaying ? now : snapshot.stateChangedAt;

    ctx.save();
    ctx.globalAlpha = opacity;
    for (let index = 0; index < bars; index += 1) {
      const seedOffset = ((index * 17) % 97) * 0.01;
      const wave = Math.abs(Math.sin(phaseTime / 380 + index * 0.62 + seedOffset));
      const randomWave = Math.abs(Math.sin(phaseTime / 620 + index * 0.18 + seedOffset * 2.3));
      const combined = clamp((wave * 0.72) + (randomWave * 0.28), 0.18, 1);
      const barHeight = Math.max(7, combined * height);
      const barX = x + index * (barWidth + gap);
      const barY = y + (height - barHeight);
      fillRoundRect(ctx, barX, barY, barWidth, barHeight, 3, index % 2 === 0 ? "#7fe0ff" : "#ffffff");
    }
    ctx.restore();
  }

  drawProgressBar(ctx, progress) {
    const clamped = clamp(progress, 0, 1);
    fillRoundRect(ctx, 10, 132, 124, 5, 3, "rgba(255,255,255,0.22)");
    fillRoundRect(ctx, 10, 132, Math.max(6, 124 * clamped), 5, 3, "#0b6cf4");
  }

  drawDebug(ctx, contextKey, snapshot, now) {
    if (!this.debug) {
      return;
    }

    const stat = this.updateStats(contextKey, now);
    fillRoundRect(ctx, 8, 8, 72, 26, 9, "rgba(0,0,0,0.52)");
    ctx.fillStyle = "#ffffff";
    ctx.font = "600 10px Consolas";
    ctx.textBaseline = "middle";
    ctx.fillText(`${stat.fps.toFixed(1)} fps`, 14, 18);
    ctx.fillText(`${snapshot.bridge}`, 14, 28);
  }

  async renderNowPlaying(context, snapshot, overlay) {
    const canvas = createCanvas(RENDER.KEY_SIZE, RENDER.KEY_SIZE);
    const ctx = canvas.getContext("2d");
    const artwork = await this.cache.getArtwork(snapshot);
    const now = snapshot.now;

    this.drawArtwork(ctx, artwork?.image, RENDER.KEY_SIZE, RENDER.KEY_SIZE);
    ctx.fillStyle = snapshot.active ? "rgba(7, 12, 20, 0.20)" : "rgba(7, 12, 20, 0.62)";
    ctx.fillRect(0, 0, RENDER.KEY_SIZE, RENDER.KEY_SIZE);

    const textGradient = ctx.createLinearGradient(0, 70, 0, 144);
    textGradient.addColorStop(0, "rgba(0,0,0,0)");
    textGradient.addColorStop(0.35, "rgba(0,0,0,0.40)");
    textGradient.addColorStop(1, "rgba(0,0,0,0.86)");
    ctx.fillStyle = textGradient;
    ctx.fillRect(0, 60, 144, 84);

    const title = snapshot.hasMedia ? snapshot.title || "Unknown Track" : "TIDAL";
    const artist = snapshot.hasMedia ? snapshot.artist || "Unknown Artist" : "No media";

    ctx.fillStyle = "#ffffff";
    ctx.font = "700 18px Segoe UI";
    const titleState = this.drawMarquee(ctx, `${context.context}:title`, title, 12, 102, 120, now, "700 18px Segoe UI", "#ffffff");

    ctx.font = "600 14px Segoe UI";
    const artistState = this.drawMarquee(ctx, `${context.context}:artist`, artist, 12, 122, 120, now, "600 14px Segoe UI", "rgba(225,233,241,0.92)");

    fillRoundRect(ctx, 104, 12, 28, 28, 10, "rgba(0,0,0,0.46)");
    const iconKind = snapshot.hasMedia ? (snapshot.isPlaying ? "pause" : "play") : "play";
    this.drawTransportIcon(ctx, iconKind, 118, 26, 18, "#ffffff");

    this.drawProgressBar(ctx, snapshot.progress);
    this.drawDebug(ctx, context.context, snapshot, now);

    const fingerprint = JSON.stringify({
      action: context.action,
      trackId: snapshot.trackId,
      playback: snapshot.playbackStatus,
      progressBucket: snapshot.hasMedia ? Math.floor(snapshot.positionMs / RENDER.LOOP_MS) : 0,
      volumeBucket: overlay ? Math.round(overlay.value / 5) : 0,
      scroll: titleState.shouldScroll || artistState.shouldScroll ? Math.floor(now / RENDER.LOOP_MS) : 0,
      artwork: artwork?.key || snapshot.artworkHash,
      debug: this.debug ? Math.floor(now / 1000) : 0,
    });

    const output = {
      image: canvasToDataUrl(canvas),
      fingerprint,
    };

    if (context.controller === "Encoder") {
      output.feedback = {
        bg: this.renderNowPlayingTouchBackground(snapshot, artwork),
        title: snapshot.hasMedia ? (snapshot.title || "Now Playing") : "TIDAL",
        artist: snapshot.hasMedia ? (snapshot.artist || snapshot.playbackStatus) : "No media",
        progress: Math.round(snapshot.progress * 100),
      };
      output.fingerprint = JSON.stringify({
        ...JSON.parse(fingerprint),
        controller: context.controller,
        feedbackBucket: Math.floor(snapshot.positionMs / 1000),
      });
    }

    return output;
  }

  async renderTransportButton(context, snapshot, kind) {
    const canvas = createCanvas(RENDER.KEY_SIZE, RENDER.KEY_SIZE);
    const ctx = canvas.getContext("2d");
    const now = snapshot.now;
    const label = !snapshot.active
      ? "No Media"
      : kind === "playpause"
        ? (snapshot.isPlaying ? "Pause" : "Play")
        : (kind === "next" ? "Next" : "Previous");
    const preview = snapshot.active && snapshot.hasMedia
      ? (kind === "next" ? snapshot.queueHints?.next : (kind === "previous" ? snapshot.queueHints?.previous : null))
      : null;

    let previewArtwork = null;
    if (preview?.artworkPath) {
      previewArtwork = await this.cache.getArtwork({
        hasMedia: true,
        appId: snapshot.appId,
        title: preview.title || "",
        artist: preview.artist || "",
        album: preview.album || "",
        artworkPath: preview.artworkPath || "",
        artworkHash: preview.artworkHash || "",
        artworkContentType: preview.artworkContentType || "",
      });
    }

    fillRoundRect(ctx, 0, 0, 144, 144, 28, "#0b1220");

    if (preview) {
      ctx.save();
      roundRectPath(ctx, 6, 6, 132, 132, 24);
      ctx.clip();
      if (previewArtwork?.image) {
        this.drawArtwork(ctx, previewArtwork.image, 144, 144);
      } else {
        this.drawPlaceholderArt(ctx, 144, 144, preview.title || label);
      }
      const overlay = ctx.createLinearGradient(0, 0, 0, 144);
      overlay.addColorStop(0, "rgba(5,10,18,0.24)");
      overlay.addColorStop(0.55, "rgba(5,10,18,0.34)");
      overlay.addColorStop(1, "rgba(5,10,18,0.88)");
      ctx.fillStyle = overlay;
      ctx.fillRect(0, 0, 144, 144);
      ctx.restore();

      fillRoundRect(ctx, 14, 14, 60, 20, 10, "rgba(0,0,0,0.44)");
      fillRoundRect(ctx, 100, 16, 28, 28, 10, "rgba(0,0,0,0.4)");
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 10px Segoe UI";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label.toUpperCase(), 44, 24);
      this.drawTransportIcon(ctx, kind, 114, 30, 18, "#ffffff");
      this.drawPreviewText(
        ctx,
        14,
        100,
        116,
        preview.title || label,
        preview.artist || "",
        now,
        `${context.context}:${kind}`,
      );
    } else {
      const background = ctx.createLinearGradient(0, 0, 144, 144);
      background.addColorStop(0, snapshot.active ? "#0f1a32" : "#10141f");
      background.addColorStop(1, snapshot.active ? "#0b6cf4" : "#1b2437");
      ctx.fillStyle = background;
      fillRoundRect(ctx, 6, 6, 132, 132, 24, background);

      ctx.globalAlpha = snapshot.active ? 1 : 0.45;
      strokeRoundRect(ctx, 10, 10, 124, 124, 22, "rgba(255,255,255,0.22)", 2);
      this.drawTransportIcon(ctx, kind === "playpause" ? (snapshot.isPlaying ? "pause" : "play") : kind, 72, 66, 52, "#ffffff");
      ctx.globalAlpha = 1;

      ctx.fillStyle = "#ffffff";
      ctx.font = "700 13px Segoe UI";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 72, 112);
    }

    if (kind === "playpause" && snapshot.active) {
      this.drawProgressBar(ctx, snapshot.progress);
    } else {
      fillRoundRect(ctx, 20, 130, 104, 4, 2, "rgba(255,255,255,0.18)");
    }

    this.drawDebug(ctx, context.context, snapshot, now);

    const output = {
      image: canvasToDataUrl(canvas),
      fingerprint: JSON.stringify({
        action: context.action,
        controller: context.controller,
        active: snapshot.active,
        playback: snapshot.playbackStatus,
        trackId: snapshot.trackId,
        previewTrackId: preview?.trackId || "",
        previewArtwork: previewArtwork?.key || preview?.artworkHash || "",
        progressBucket: kind === "playpause" ? Math.floor(snapshot.positionMs / 1000) : 0,
        scrollBucket: preview ? Math.floor(now / RENDER.LOOP_MS) : 0,
        debug: this.debug ? Math.floor(now / 1000) : 0,
      }),
    };

    if (context.controller === "Encoder") {
      if (kind === "next" || kind === "previous") {
        output.feedback = {
          bg: this.renderTransportTouchBackground(snapshot, kind, label, preview, previewArtwork),
          title: preview
            ? (preview.title || label)
            : (snapshot.active ? label : "No Media"),
          artist: preview
            ? (preview.artist || "")
            : (snapshot.active ? "Preview unavailable" : "No media"),
        };
      } else {
        output.feedback = {
          title: label,
          value: preview ? (preview.title || preview.artist || label) : (snapshot.hasMedia ? (snapshot.title || snapshot.artist || "TIDAL") : "No media"),
          indicator: {
            value: kind === "playpause" ? Math.round(snapshot.progress * 100) : 0,
            bar_fill_c: snapshot.active ? "#0b6cf4" : "#536075",
          },
        };
      }
    }

    return output;
  }

  renderVolume(context, snapshot, overlay) {
    const canvas = createCanvas(RENDER.ENCODER_ICON_SIZE, RENDER.ENCODER_ICON_SIZE);
    const ctx = canvas.getContext("2d");
    const now = snapshot.now;
    const volume = overlay ? overlay.value : Math.round(snapshot.volume.value);
    const muted = overlay ? overlay.muted : snapshot.volume.muted;
    const accent = muted ? "#f45f5f" : (snapshot.volume.source === "session" ? "#0b6cf4" : "#44c17a");

    fillRoundRect(ctx, 0, 0, 144, 144, 72, "#09111d");
    const background = ctx.createLinearGradient(0, 0, 144, 144);
    background.addColorStop(0, "rgba(17,29,52,1)");
    background.addColorStop(1, "rgba(8,93,180,1)");
    ctx.fillStyle = background;
    fillRoundRect(ctx, 8, 8, 128, 128, 64, background);

    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(72, 72, 42, -Math.PI * 0.75, Math.PI * 0.75);
    ctx.stroke();

    ctx.strokeStyle = accent;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(72, 72, 42, -Math.PI * 0.75, -Math.PI * 0.75 + (Math.PI * 1.5 * clamp(volume / 100, 0, 1)));
    ctx.stroke();

    this.drawTransportIcon(ctx, "speaker", 72, 58, 42, "#ffffff");

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 24px Segoe UI";
    ctx.fillText(muted ? "MUTE" : `${volume}%`, 72, 100);

    if (overlay) {
      ctx.globalAlpha = clamp(overlay.opacity, 0, 1);
      fillRoundRect(ctx, 20, 18, 104, 24, 10, "rgba(0,0,0,0.48)");
      ctx.fillStyle = "#ffffff";
      ctx.font = "600 12px Segoe UI";
      ctx.fillText(overlay.source === "session" ? "TIDAL volume" : "System volume", 72, 30);
      ctx.globalAlpha = 1;
    }

    this.drawDebug(ctx, context.context, snapshot, now);

    return {
      image: canvasToDataUrl(canvas),
      fingerprint: JSON.stringify({
        action: context.action,
        volume,
        muted,
        overlayTick: overlay ? Math.floor((overlay.expiresAt - now) / 100) : 0,
        source: snapshot.volume.source,
        debug: this.debug ? Math.floor(now / 1000) : 0,
      }),
      feedback: {
        title: snapshot.volume.source === "session" ? "TIDAL" : "System",
        value: muted ? "Muted" : `${volume}%`,
        indicator: {
          value: muted ? 0 : volume,
          bar_fill_c: accent,
        },
      },
    };
  }

  async renderContext(context, snapshot, overlay) {
    switch (context.action) {
      case ACTIONS.NOW_PLAYING:
        return this.renderNowPlaying(context, snapshot, overlay);
      case ACTIONS.PLAY_PAUSE:
        return this.renderTransportButton(context, snapshot, "playpause");
      case ACTIONS.NEXT:
        return this.renderTransportButton(context, snapshot, "next");
      case ACTIONS.PREVIOUS:
        return this.renderTransportButton(context, snapshot, "previous");
      case ACTIONS.VOLUME:
        return this.renderVolume(context, snapshot, overlay);
      default:
        return null;
    }
  }
}

module.exports = {
  Renderer,
};
