"use strict";

const { EventEmitter } = require("events");
const WebSocket = require("ws");

class StreamDeckConnection extends EventEmitter {
  constructor({ logger }) {
    super();
    this.logger = logger;
    this.registration = null;
    this.ws = null;
  }

  parseArgs(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index += 1) {
      const key = argv[index];
      const value = argv[index + 1];
      if (!key.startsWith("-")) {
        continue;
      }

      result[key.slice(1)] = value;
      index += 1;
    }

    result.info = result.info ? JSON.parse(result.info) : {};
    return result;
  }

  async connect(argv) {
    this.registration = this.parseArgs(argv);
    const port = Number(this.registration.port);

    this.logger.info("connecting", {
      port,
      pluginUUID: this.registration.pluginUUID,
      registerEvent: this.registration.registerEvent,
    });

    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);

    this.ws.on("open", () => {
      this.send({
        event: this.registration.registerEvent,
        uuid: this.registration.pluginUUID,
      });
      this.emit("ready", this.registration.info);
    });

    this.ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString("utf8"));
        this.emit("message", message);
        if (message.event) {
          this.emit(message.event, message);
        }
      } catch (error) {
        this.logger.error("message-parse-failed", {
          error: error.message,
          raw: raw.toString("utf8"),
        });
      }
    });

    this.ws.on("close", () => {
      this.logger.warn("websocket-closed");
      this.emit("close");
    });

    this.ws.on("error", (error) => {
      this.logger.error("websocket-error", { error: error.message });
      this.emit("error", error);
    });
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify(payload));
  }

  setImage(context, image, target) {
    const payload = { image };
    if (typeof target === "number") {
      payload.target = target;
    }

    this.send({
      event: "setImage",
      context,
      payload,
    });
  }

  setFeedbackLayout(context, layout) {
    this.send({
      event: "setFeedbackLayout",
      context,
      payload: {
        layout,
      },
    });
  }

  setFeedback(context, feedback) {
    this.send({
      event: "setFeedback",
      context,
      payload: feedback,
    });
  }

  showAlert(context) {
    this.send({
      event: "showAlert",
      context,
    });
  }

  showOk(context) {
    this.send({
      event: "showOk",
      context,
    });
  }
}

module.exports = {
  StreamDeckConnection,
};
