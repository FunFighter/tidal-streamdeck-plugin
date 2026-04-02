"use strict";

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const DEFAULT_LEVEL = process.env.TIDAL_PREMIUM_LOG_LEVEL || (process.env.TIDAL_PREMIUM_DEBUG ? "debug" : "info");

function levelValue(name) {
  return LEVELS[name] ?? LEVELS.info;
}

class Logger {
  constructor(scope, levelName = DEFAULT_LEVEL) {
    this.scope = scope;
    this.level = levelValue(levelName);
  }

  child(scope) {
    return new Logger(scope, this.levelName());
  }

  levelName() {
    return Object.keys(LEVELS).find((name) => LEVELS[name] === this.level) || "info";
  }

  shouldLog(levelName) {
    return levelValue(levelName) <= this.level;
  }

  write(levelName, message, meta) {
    if (!this.shouldLog(levelName)) {
      return;
    }

    const payload = {
      ts: new Date().toISOString(),
      level: levelName,
      scope: this.scope,
      message,
    };

    if (meta && typeof meta === "object" && Object.keys(meta).length) {
      payload.meta = meta;
    }

    const line = JSON.stringify(payload);
    if (levelName === "error") {
      console.error(line);
      return;
    }

    console.log(line);
  }

  error(message, meta) {
    this.write("error", message, meta);
  }

  warn(message, meta) {
    this.write("warn", message, meta);
  }

  info(message, meta) {
    this.write("info", message, meta);
  }

  debug(message, meta) {
    this.write("debug", message, meta);
  }
}

function createLogger(scope) {
  return new Logger(scope);
}

module.exports = {
  LEVELS,
  Logger,
  createLogger,
};
