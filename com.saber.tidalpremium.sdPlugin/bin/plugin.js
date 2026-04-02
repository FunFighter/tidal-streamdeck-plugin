"use strict";

const path = require("path");
const { createLogger } = require("./logger");
const { StreamDeckConnection } = require("./streamDeck");
const { MediaSession } = require("./mediaSession");
const { Controls } = require("./controls");
const { AlbumArtCache } = require("./cache");
const { Renderer } = require("./renderer");
const { ACTIONS, RENDER } = require("./constants");

const logger = createLogger("plugin");
const pluginDir = __dirname;
const connection = new StreamDeckConnection({ logger: createLogger("streamdeck") });
const mediaSession = new MediaSession({ pluginDir, logger: createLogger("media") });
const controls = new Controls({ mediaSession, logger: createLogger("controls") });
const cache = new AlbumArtCache({ pluginDir, logger: createLogger("cache") });
const renderer = new Renderer({
  cache,
  logger: createLogger("renderer"),
  debug: Boolean(process.env.TIDAL_PREMIUM_DEBUG),
});

const contexts = new Map();
let rendering = false;
let queuedRender = false;

function getEncoderLayout(context) {
  if (context.action === ACTIONS.NOW_PLAYING) {
    return "layouts/nowplaying-encoder.json";
  }

  if (context.action === ACTIONS.NEXT || context.action === ACTIONS.PREVIOUS) {
    return "layouts/transport-encoder.json";
  }

  return "$B1";
}

function upsertContext(message) {
  const existing = contexts.get(message.context) || {};
  const next = {
    ...existing,
    context: message.context,
    action: message.action,
    device: message.device,
    controller: message.payload?.controller || existing.controller || "Keypad",
    coordinates: message.payload?.coordinates || existing.coordinates || null,
    settings: message.payload?.settings || existing.settings || {},
    feedbackLayoutSet: existing.feedbackLayoutSet || false,
    lastFingerprint: existing.lastFingerprint || "",
    lastFeedbackFingerprint: existing.lastFeedbackFingerprint || "",
  };

  contexts.set(message.context, next);
  return next;
}

async function renderPass(reason) {
  if (rendering) {
    queuedRender = true;
    return;
  }

  rendering = true;
  const snapshot = mediaSession.getSnapshot();

  try {
    for (const context of contexts.values()) {
      const overlay = controls.getOverlay(context.context, snapshot.now);
      const output = await renderer.renderContext(context, snapshot, overlay);
      if (!output) {
        continue;
      }

      if (output.fingerprint !== context.lastFingerprint) {
        connection.setImage(context.context, output.image);
        context.lastFingerprint = output.fingerprint;
      }

      if (context.controller === "Encoder" && !context.feedbackLayoutSet) {
        connection.setFeedbackLayout(context.context, getEncoderLayout(context));
        context.feedbackLayoutSet = true;
      }

      if (output.feedback) {
        const feedbackFingerprint = JSON.stringify(output.feedback);
        if (feedbackFingerprint !== context.lastFeedbackFingerprint) {
          connection.setFeedback(context.context, output.feedback);
          context.lastFeedbackFingerprint = feedbackFingerprint;
        }
      }
    }

    logger.debug("render-pass", {
      reason,
      visibleContexts: contexts.size,
      title: snapshot.title,
      playbackStatus: snapshot.playbackStatus,
    });
  } catch (error) {
    logger.error("render-pass-failed", { error: error.message, stack: error.stack });
  } finally {
    rendering = false;
    if (queuedRender) {
      queuedRender = false;
      setImmediate(() => {
        void renderPass("queued");
      });
    }
  }
}

async function handleMessage(message) {
  switch (message.event) {
    case "willAppear": {
      const context = upsertContext(message);
      if (context.controller === "Encoder" && !context.feedbackLayoutSet) {
        connection.setFeedbackLayout(context.context, getEncoderLayout(context));
        context.feedbackLayoutSet = true;
      }
      await renderPass("willAppear");
      return;
    }
    case "willDisappear":
      contexts.delete(message.context);
      return;
    case "didReceiveSettings":
      upsertContext(message);
      return;
    case "keyDown":
      await controls.onKeyDown(message);
      await renderPass("keyDown");
      return;
    case "dialRotate":
      await controls.onDialRotate(message);
      await renderPass("dialRotate");
      return;
    case "dialUp":
      await controls.onDialUp(message);
      await renderPass("dialUp");
      return;
    case "touchTap":
      await controls.onTouchTap(message);
      await renderPass("touchTap");
      return;
    case "applicationDidLaunch":
    case "applicationDidTerminate":
      if (/tidal/i.test(message.payload?.application || "")) {
        await mediaSession.pollNow(message.event);
        if (message.event === "applicationDidLaunch") {
          mediaSession.requestWarmup(message.event);
        }
        await renderPass(message.event);
      }
      return;
    default:
      return;
  }
}

async function main() {
  process.on("uncaughtException", (error) => {
    logger.error("uncaught-exception", { error: error.message, stack: error.stack });
  });

  process.on("unhandledRejection", (error) => {
    logger.error("unhandled-rejection", {
      error: error?.message || String(error),
      stack: error?.stack,
    });
  });

  await connection.connect(process.argv.slice(2));
  connection.on("message", (message) => {
    void handleMessage(message);
  });

  connection.on("close", () => {
    mediaSession.stop();
  });

  mediaSession.on("update", () => {
    void renderPass("media-update");
  });

  mediaSession.on("volume", () => {
    void renderPass("volume-update");
  });

  await mediaSession.start();
  setInterval(() => {
    void renderPass("tick");
  }, RENDER.LOOP_MS);

  logger.info("plugin-started", {
    pluginDir: path.resolve(pluginDir),
    debug: Boolean(process.env.TIDAL_PREMIUM_DEBUG),
  });
}

void main();
