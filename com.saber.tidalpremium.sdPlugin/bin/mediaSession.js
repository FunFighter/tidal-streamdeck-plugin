"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const util = require("util");
const childProcess = require("child_process");
const loudness = require("loudness");
const { RENDER } = require("./constants");

const execFile = util.promisify(childProcess.execFile);
const QUEUE_PREVIEW_CACHE_MS = 15000;
const QUEUE_PREVIEW_DEBOUNCE_MS = 2500;
const QUEUE_PREVIEW_TIMEOUT_MS = 2500;

function roundMilliseconds(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function createEmptyState() {
  return {
    bridge: "none",
    active: false,
    hasMedia: false,
    appId: "",
    title: "",
    artist: "",
    album: "",
    trackId: "",
    durationMs: 0,
    positionMs: 0,
    sampledAt: Date.now(),
    playbackStatus: "stopped",
    isPlaying: false,
    isPaused: false,
    artworkPath: "",
    artworkHash: "",
    artworkContentType: "",
    artworkCandidates: [],
    shuffleActive: false,
    repeatMode: "none",
    queuePreviewPrevious: null,
    queuePreviewNext: null,
    queueHints: {
      previous: null,
      next: null,
    },
    sessionVolumeAvailable: false,
    volume: {
      value: 0,
      muted: false,
      source: "system",
    },
    stateChangedAt: Date.now(),
    trackChangedAt: Date.now(),
  };
}

class MediaSession extends EventEmitter {
  constructor({ pluginDir, logger }) {
    super();
    this.pluginDir = pluginDir;
    this.logger = logger;
    this.state = createEmptyState();
    this.pollTimer = null;
    this.pollInFlight = false;
    this.needsFollowUpPoll = false;
    this.warmupTimers = new Set();
    this.lastWarmupAt = 0;
    this.trackCatalog = new Map();
    this.trackTimeline = [];
    this.timelineIndex = -1;
    this.queuePreviewCache = {
      trackId: "",
      current: null,
      previous: null,
      next: null,
      sampledAt: 0,
    };
    this.queuePreviewRefresh = {
      key: "",
      requestedAt: 0,
      promise: null,
    };
    this.pendingArtworkTrackId = "";
    this.pendingArtworkStartedAt = 0;
    this.native = this.loadNativeBridge();
    this.powerShellPath = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  }

  loadNativeBridge() {
    const candidates = [
      process.env.TIDAL_PREMIUM_NATIVE_BRIDGE,
      path.resolve(this.pluginDir, "..", "..", "com.elgato.spotify.sdPlugin", "bin"),
    ].filter(Boolean);

    for (const candidate of candidates) {
      try {
        const addonPath = path.join(candidate, "spotify_win.node");
        const mediaPath = path.join(candidate, "winmediacontrols.node");
        if (!fs.existsSync(addonPath)) {
          continue;
        }

        const addon = require(addonPath);
        const media = fs.existsSync(mediaPath) ? require(mediaPath) : null;

        if (typeof addon.setAppFilter === "function") {
          addon.setAppFilter("TIDAL");
        }

        if (typeof addon.setLogging === "function" && process.env.TIDAL_PREMIUM_DEBUG) {
          addon.setLogging(true);
        }

        this.logger.info("native-bridge-loaded", {
          addonPath,
          mediaPath: mediaPath && fs.existsSync(mediaPath) ? mediaPath : null,
          info: typeof addon.getInfo === "function" ? addon.getInfo() : null,
        });

        return { addon, media };
      } catch (error) {
        this.logger.warn("native-bridge-load-failed", {
          candidate,
          error: error.message,
        });
      }
    }

    this.logger.warn("native-bridge-unavailable");
    return null;
  }

  start() {
    if (this.native?.addon && typeof this.native.addon.isEventsEnabled === "function" && this.native.addon.isEventsEnabled()) {
      try {
        this.native.addon.startListening(() => {
          this.pollNow("native-event").catch((error) => {
            this.logger.warn("native-event-poll-failed", { error: error.message });
          });
        });
      } catch (error) {
        this.logger.warn("native-listener-start-failed", { error: error.message });
      }
    }

    this.pollTimer = setInterval(() => {
      this.pollNow("interval").catch((error) => {
        this.logger.warn("poll-failed", { error: error.message });
      });
    }, RENDER.POLL_MS);

    const startupPoll = this.pollNow("startup");
    this.requestWarmup("startup");
    return startupPoll;
  }

  stop() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const timer of this.warmupTimers) {
      clearTimeout(timer);
    }
    this.warmupTimers.clear();

    if (this.native?.addon && typeof this.native.addon.stopListening === "function") {
      try {
        this.native.addon.stopListening();
      } catch (error) {
        this.logger.warn("native-listener-stop-failed", { error: error.message });
      }
    }
  }

  requestWarmup(reason, delays = RENDER.WARMUP_DELAYS_MS) {
    const now = Date.now();
    if ((now - this.lastWarmupAt) < RENDER.WARMUP_DEBOUNCE_MS) {
      return;
    }

    this.lastWarmupAt = now;
    this.logger.debug("warmup-scheduled", { reason, delays });

    for (const delay of delays) {
      const timer = setTimeout(() => {
        this.warmupTimers.delete(timer);
        this.pollNow(`warmup:${reason}:${delay}`).catch((error) => {
          this.logger.warn("warmup-poll-failed", { reason, delay, error: error.message });
        });
      }, delay);
      this.warmupTimers.add(timer);
    }
  }

  async pollNow(reason) {
    if (this.pollInFlight) {
      this.needsFollowUpPoll = true;
      return this.state;
    }

    this.pollInFlight = true;

    try {
      const nextState = this.native ? await this.pollNative() : await this.pollFallback();
      this.applyState(nextState, reason);
      return this.state;
    } finally {
      this.pollInFlight = false;
      if (this.needsFollowUpPoll) {
        this.needsFollowUpPoll = false;
        void this.pollNow("queued");
      }
    }
  }

  buildTrackId(payload) {
    return [
      payload.appId || "",
      payload.title || "",
      payload.artist || "",
      payload.album || "",
    ].join("|");
  }

  normalizeText(value) {
    return String(value || "").trim().toLowerCase();
  }

  getQueuePreviewCacheKey(track, appId) {
    return this.buildTrackId({
      appId,
      title: track?.title || "",
      artist: track?.artist || "",
      album: track?.album || "",
    });
  }

  tracksMatch(left, right) {
    if (!left || !right) {
      return false;
    }

    return this.normalizeText(left.title) === this.normalizeText(right.title)
      && this.normalizeText(left.artist) === this.normalizeText(right.artist)
      && this.normalizeText(left.album) === this.normalizeText(right.album);
  }

  tracksLikelyMatch(left, right) {
    if (!left || !right) {
      return false;
    }

    const titleLeft = this.normalizeText(left.title);
    const titleRight = this.normalizeText(right.title);
    if (!titleLeft || !titleRight || titleLeft !== titleRight) {
      return false;
    }

    const artistLeft = this.normalizeText(left.artist);
    const artistRight = this.normalizeText(right.artist);
    const albumLeft = this.normalizeText(left.album);
    const albumRight = this.normalizeText(right.album);
    const artistMatches = !artistLeft || !artistRight || artistLeft === artistRight || artistLeft.includes(artistRight) || artistRight.includes(artistLeft);
    const albumMatches = !albumLeft || !albumRight || albumLeft === albumRight || albumLeft.includes(albumRight) || albumRight.includes(albumLeft);
    return artistMatches && albumMatches;
  }

  getSidebarPreviewSnapshot(track, appId) {
    if (!track?.title && !track?.artist) {
      return {
        current: null,
        previous: null,
        next: null,
      };
    }

    const cacheKey = this.getQueuePreviewCacheKey(track, appId);
    const ageMs = Date.now() - this.queuePreviewCache.sampledAt;

    if (this.queuePreviewCache.trackId === cacheKey) {
      if (ageMs >= QUEUE_PREVIEW_CACHE_MS) {
        this.requestSidebarPreviewRefresh(track, appId, cacheKey);
      }

      return {
        current: this.queuePreviewCache.current,
        previous: this.queuePreviewCache.previous,
        next: this.queuePreviewCache.next,
      };
    }

    this.requestSidebarPreviewRefresh(track, appId, cacheKey);
    return {
      current: null,
      previous: null,
      next: null,
    };
  }

  requestSidebarPreviewRefresh(track, appId, cacheKey = this.getQueuePreviewCacheKey(track, appId)) {
    const now = Date.now();

    if (
      this.queuePreviewRefresh.key === cacheKey
      && this.queuePreviewRefresh.promise
    ) {
      return;
    }

    if (
      this.queuePreviewRefresh.key === cacheKey
      && (now - this.queuePreviewRefresh.requestedAt) < QUEUE_PREVIEW_DEBOUNCE_MS
    ) {
      return;
    }

    const refresh = {
      key: cacheKey,
      requestedAt: now,
      promise: null,
    };

    refresh.promise = this.refreshSidebarPreviews(track, appId, cacheKey).finally(() => {
      if (this.queuePreviewRefresh === refresh) {
        this.queuePreviewRefresh = {
          key: cacheKey,
          requestedAt: refresh.requestedAt,
          promise: null,
        };
      }
    });

    this.queuePreviewRefresh = refresh;
  }

  buildSidebarPreview(item, appId, source) {
    if (!item) {
      return null;
    }

    return {
      trackId: this.buildTrackId({
        appId,
        title: item.title,
        artist: item.artist,
        album: item.album,
      }),
      title: item.title || "",
      artist: item.artist || "",
      album: item.album || "",
      artworkPath: item.artworkPath || "",
      artworkHash: item.artworkHash || "",
      artworkContentType: item.artworkContentType || "",
      artworkCandidates: item.artworkPath
        ? [{
          artworkPath: item.artworkPath || "",
          artworkHash: item.artworkHash || "",
          artworkContentType: item.artworkContentType || "",
          source,
        }]
        : [],
      source,
    };
  }

  updateQueuePreviewCache(cacheKey, previews, reason = "queue-preview-refresh") {
    const previousSignature = JSON.stringify({
      current: this.queuePreviewCache.current?.trackId || "",
      previous: this.queuePreviewCache.previous?.trackId || "",
      next: this.queuePreviewCache.next?.trackId || "",
    });

    this.queuePreviewCache = {
      trackId: cacheKey,
      current: previews.current || null,
      previous: previews.previous || null,
      next: previews.next || null,
      sampledAt: Date.now(),
    };

    const nextSignature = JSON.stringify({
      current: this.queuePreviewCache.current?.trackId || "",
      previous: this.queuePreviewCache.previous?.trackId || "",
      next: this.queuePreviewCache.next?.trackId || "",
    });

    if (this.state.trackId !== cacheKey || previousSignature === nextSignature) {
      return;
    }

    const artworkState = previews.current
      ? this.createArtworkState(
        previews.current,
        ...(Array.isArray(this.state.artworkCandidates) ? this.state.artworkCandidates : []),
        this.state,
      )
      : {
        artworkPath: this.state.artworkPath,
        artworkHash: this.state.artworkHash,
        artworkContentType: this.state.artworkContentType,
        artworkCandidates: Array.isArray(this.state.artworkCandidates) ? this.state.artworkCandidates.slice() : [],
      };

    this.applyState({
      ...this.state,
      artworkPath: artworkState.artworkPath,
      artworkHash: artworkState.artworkHash,
      artworkContentType: artworkState.artworkContentType,
      artworkCandidates: artworkState.artworkCandidates,
      queuePreviewPrevious: previews.previous || null,
      queuePreviewNext: previews.next || null,
    }, reason);
  }

  async refreshSidebarPreviews(track, appId, cacheKey) {
    try {
      const payload = await this.runFallbackScript("read-tidal-queue.ps1", [
        "-CurrentTitle",
        track?.title || "",
        "-CurrentArtist",
        track?.artist || "",
        "-CurrentAlbum",
        track?.album || "",
      ], {
        timeoutMs: QUEUE_PREVIEW_TIMEOUT_MS,
      });

      const current = payload?.current || null;
      const previous = payload?.previous || null;
      const next = payload?.next || null;

      if (!payload?.ok || !payload.visible || !this.tracksLikelyMatch(track, current)) {
        this.updateQueuePreviewCache(cacheKey, {
          current: null,
          previous: null,
          next: null,
        }, "queue-preview-clear");
        return;
      }

      this.updateQueuePreviewCache(cacheKey, {
        current: this.buildSidebarPreview(current, appId, "sidebar-current"),
        previous: this.buildSidebarPreview(previous, appId, "history"),
        next: this.buildSidebarPreview(next, appId, "queue"),
      });
    } catch (error) {
      this.logger.warn("queue-preview-read-failed", { error: error.message });
    }
  }

  createArtworkCandidate(artwork, source) {
    if (!artwork?.artworkPath) {
      return null;
    }

    return {
      artworkPath: artwork.artworkPath || "",
      artworkHash: artwork.artworkHash || "",
      artworkContentType: artwork.artworkContentType || "",
      source: source || artwork.source || "",
    };
  }

  mergeArtworkCandidates(...artworks) {
    const candidates = [];
    const seen = new Set();

    for (const artwork of artworks) {
      const candidate = this.createArtworkCandidate(artwork, artwork?.source);
      if (!candidate) {
        continue;
      }

      const dedupeKey = `${candidate.artworkHash || ""}|${candidate.artworkPath || ""}`;
      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      candidates.push(candidate);
    }

    return candidates;
  }

  createArtworkState(...artworks) {
    const candidates = this.mergeArtworkCandidates(...artworks);
    const primary = candidates[0] || null;
    return {
      artworkPath: primary?.artworkPath || "",
      artworkHash: primary?.artworkHash || "",
      artworkContentType: primary?.artworkContentType || "",
      artworkCandidates: candidates,
    };
  }

  async getGSMTCArtwork(track) {
    if (!track?.title && !track?.artist) {
      return null;
    }

    try {
      const payload = await this.runFallbackScript("read-gsmtc.ps1", ["-AppFilter", "TIDAL"]);
      if (!payload?.ok || !payload.active || !payload.artworkPath) {
        return null;
      }

      if (!this.tracksMatch(track, payload)) {
        return null;
      }

      return {
        artworkPath: payload.artworkPath || "",
        artworkHash: payload.artworkHash || "",
        artworkContentType: payload.artworkContentType || "",
      };
    } catch (error) {
      this.logger.warn("gsmtc-artwork-read-failed", { error: error.message });
      return null;
    }
  }

  isSameArtworkIdentity(left, right) {
    if (!left || !right) {
      return false;
    }

    if (left.artworkHash && right.artworkHash) {
      return left.artworkHash === right.artworkHash;
    }

    if (left.artworkPath && right.artworkPath) {
      return left.artworkPath === right.artworkPath;
    }

    return false;
  }

  reconcileArtwork(nextState, previous, now) {
    if (!nextState?.hasMedia || !nextState.trackId) {
      this.pendingArtworkTrackId = "";
      this.pendingArtworkStartedAt = 0;
      return nextState;
    }

    const hasArtwork = Boolean(nextState.artworkHash || nextState.artworkPath);
    const sameTrack = Boolean(previous?.trackId) && previous.trackId === nextState.trackId;

    if (sameTrack && !hasArtwork && (previous.artworkHash || previous.artworkPath)) {
      return {
        ...nextState,
        artworkPath: previous.artworkPath,
        artworkHash: previous.artworkHash,
        artworkContentType: previous.artworkContentType,
        artworkCandidates: Array.isArray(previous.artworkCandidates) ? previous.artworkCandidates.slice() : [],
      };
    }

    if (sameTrack) {
      if (hasArtwork) {
        this.pendingArtworkTrackId = "";
        this.pendingArtworkStartedAt = 0;
      }
      return nextState;
    }

    const hasPreviousArtwork = Boolean(previous?.artworkHash || previous?.artworkPath);
    const isAmbiguousTrackChange = hasArtwork && hasPreviousArtwork && this.isSameArtworkIdentity(nextState, previous);

    if (!isAmbiguousTrackChange) {
      this.pendingArtworkTrackId = "";
      this.pendingArtworkStartedAt = 0;
      return nextState;
    }

    if (this.pendingArtworkTrackId !== nextState.trackId) {
      this.pendingArtworkTrackId = nextState.trackId;
      this.pendingArtworkStartedAt = now;
    }

    const pendingAgeMs = now - this.pendingArtworkStartedAt;
    if (pendingAgeMs < 1200) {
      return {
        ...nextState,
        artworkPath: "",
        artworkHash: "",
        artworkContentType: "",
        artworkCandidates: [],
      };
    }

    this.pendingArtworkTrackId = "";
    this.pendingArtworkStartedAt = 0;
    return nextState;
  }

  rememberTrack(state) {
    if (!state?.trackId || !state?.hasMedia) {
      return;
    }

    this.trackCatalog.set(state.trackId, {
      trackId: state.trackId,
      title: state.title || "",
      artist: state.artist || "",
      album: state.album || "",
      artworkPath: state.artworkPath || "",
      artworkHash: state.artworkHash || "",
      artworkContentType: state.artworkContentType || "",
      artworkCandidates: Array.isArray(state.artworkCandidates) ? state.artworkCandidates.slice() : [],
    });
  }

  mergePreviewWithCatalog(preview) {
    if (!preview?.trackId) {
      return preview || null;
    }

    const catalogEntry = this.trackCatalog.get(preview.trackId);
    if (!catalogEntry) {
      return preview;
    }

    const artworkState = this.createArtworkState(
      catalogEntry,
      ...(Array.isArray(preview.artworkCandidates) ? preview.artworkCandidates : []),
      preview,
    );

    return {
      ...preview,
      artworkPath: artworkState.artworkPath,
      artworkHash: artworkState.artworkHash,
      artworkContentType: artworkState.artworkContentType,
      artworkCandidates: artworkState.artworkCandidates,
    };
  }

  syncTrackTimeline(next) {
    if (!next?.trackId || !next?.hasMedia) {
      return;
    }

    if (this.timelineIndex === -1 || this.trackTimeline.length === 0) {
      this.trackTimeline = [next.trackId];
      this.timelineIndex = 0;
      return;
    }

    const currentTrackId = this.trackTimeline[this.timelineIndex];
    if (next.trackId === currentTrackId) {
      return;
    }

    const previousTrackId = this.timelineIndex > 0 ? this.trackTimeline[this.timelineIndex - 1] : null;
    const forwardTrackId = this.timelineIndex < this.trackTimeline.length - 1 ? this.trackTimeline[this.timelineIndex + 1] : null;

    if (previousTrackId && next.trackId === previousTrackId) {
      this.timelineIndex -= 1;
      return;
    }

    if (forwardTrackId && next.trackId === forwardTrackId) {
      this.timelineIndex += 1;
      return;
    }

    this.trackTimeline = this.trackTimeline.slice(0, this.timelineIndex + 1);
    this.trackTimeline.push(next.trackId);
    this.timelineIndex = this.trackTimeline.length - 1;

    if (this.trackTimeline.length > 100) {
      const dropCount = this.trackTimeline.length - 100;
      this.trackTimeline.splice(0, dropCount);
      this.timelineIndex = Math.max(0, this.timelineIndex - dropCount);
    }
  }

  getQueueHints(state) {
    if (!state?.hasMedia || !state.trackId) {
      return {
        previous: null,
        next: null,
      };
    }

    if (this.trackTimeline[this.timelineIndex] !== state.trackId) {
      return {
        previous: null,
        next: null,
      };
    }

    const previousId = this.timelineIndex > 0 ? this.trackTimeline[this.timelineIndex - 1] : null;
    const nextId = this.timelineIndex < this.trackTimeline.length - 1 ? this.trackTimeline[this.timelineIndex + 1] : null;

    const previousPreview = state.queuePreviewPrevious || (previousId ? this.trackCatalog.get(previousId) || null : null);
    const nextPreview = state.queuePreviewNext || (!state.shuffleActive && nextId ? this.trackCatalog.get(nextId) || null : null);

    return {
      previous: this.mergePreviewWithCatalog(previousPreview),
      next: this.mergePreviewWithCatalog(nextPreview),
    };
  }

  buildSignature(state) {
    return JSON.stringify({
      active: state.active,
      hasMedia: state.hasMedia,
      appId: state.appId,
      trackId: state.trackId,
      playbackStatus: state.playbackStatus,
      shuffleActive: state.shuffleActive,
      durationMs: Math.round(state.durationMs / 250),
      positionMs: Math.round(state.positionMs / 500),
      artworkHash: state.artworkHash,
      artworkPath: state.artworkPath || "",
      queuePreviewPrevious: state.queuePreviewPrevious?.trackId || "",
      queuePreviewNext: state.queuePreviewNext?.trackId || "",
      previousHint: state.queueHints?.previous?.trackId || "",
      nextHint: state.queueHints?.next?.trackId || "",
      volume: Math.round(state.volume.value),
      muted: state.volume.muted,
      volumeSource: state.volume.source,
    });
  }

  applyState(nextState, reason) {
    const previous = this.state;
    const now = Date.now();
    const reconciledState = this.reconcileArtwork(nextState, previous, now);

    this.rememberTrack(reconciledState);
    this.syncTrackTimeline(reconciledState);
    reconciledState.queueHints = this.getQueueHints(reconciledState);

    if (previous.playbackStatus !== reconciledState.playbackStatus) {
      reconciledState.stateChangedAt = now;
    } else {
      reconciledState.stateChangedAt = previous.stateChangedAt || now;
    }

    if (previous.trackId !== reconciledState.trackId) {
      reconciledState.trackChangedAt = now;
    } else {
      reconciledState.trackChangedAt = previous.trackChangedAt || now;
    }

    const previousSignature = this.buildSignature(previous);
    const nextSignature = this.buildSignature(reconciledState);
    this.state = reconciledState;

    if (previousSignature !== nextSignature) {
      this.logger.info("media-state-updated", {
        reason,
        bridge: reconciledState.bridge,
        active: reconciledState.active,
        playbackStatus: reconciledState.playbackStatus,
        title: reconciledState.title,
        artist: reconciledState.artist,
        volumeSource: reconciledState.volume.source,
        artworkPending: !reconciledState.artworkHash && !reconciledState.artworkPath && Boolean(reconciledState.trackId),
      });
      this.emit("update", this.getSnapshot());
    }
  }

  async pollNative() {
    const nowPlaying = this.native.addon.getNowPlaying();
    const volume = await this.getVolumeState();

    if (!nowPlaying || !nowPlaying.ok || !nowPlaying.app) {
      return {
        ...createEmptyState(),
        bridge: "native",
        sampledAt: Date.now(),
        volume,
      };
    }

    let artwork = null;
    try {
      artwork = typeof this.native.addon.getArtwork === "function" ? this.native.addon.getArtwork() : null;
    } catch (error) {
      this.logger.warn("native-artwork-failed", { error: error.message });
    }

    const durationMs = roundMilliseconds(nowPlaying.duration || (Number(nowPlaying.durationSeconds) || 0) * 1000);
    const positionMs = roundMilliseconds((Number(nowPlaying.positionSeconds) || 0) * 1000);
    const playbackStatus = String(nowPlaying.playbackStatus || "stopped").toLowerCase();
    const active = /tidal/i.test(nowPlaying.app || "");
    const track = {
      title: nowPlaying.title || "",
      artist: nowPlaying.artist || "",
      album: nowPlaying.albumTitle || "",
    };
    const nativeArtwork = artwork?.ok
      ? {
        artworkPath: artwork.path || "",
        artworkHash: artwork.trackHash || "",
        artworkContentType: artwork.contentType || "",
        source: "native",
      }
      : null;
    const currentTrackId = this.getQueuePreviewCacheKey(track, nowPlaying.app || "");
    const sameTrackAsPrevious = active && currentTrackId === this.state.trackId;
    const gsmtcArtwork = active && (sameTrackAsPrevious || !nativeArtwork) ? await this.getGSMTCArtwork(track) : null;
    const sidebarPreviews = active ? this.getSidebarPreviewSnapshot(track, nowPlaying.app || "") : {
      current: null,
      previous: null,
      next: null,
    };
    const artworkState = this.createArtworkState(
      gsmtcArtwork && { ...gsmtcArtwork, source: "gsmtc" },
      nativeArtwork,
      sidebarPreviews.current,
    );

    return {
      bridge: "native",
      active,
      hasMedia: active && Boolean(nowPlaying.title || nowPlaying.artist || durationMs),
      appId: nowPlaying.app || "",
      title: track.title,
      artist: track.artist,
      album: track.album,
      trackId: currentTrackId,
      durationMs,
      positionMs,
      sampledAt: Date.now(),
      playbackStatus,
      isPlaying: playbackStatus === "playing",
      isPaused: playbackStatus === "paused",
      artworkPath: artworkState.artworkPath,
      artworkHash: artworkState.artworkHash,
      artworkContentType: artworkState.artworkContentType,
      artworkCandidates: artworkState.artworkCandidates,
      shuffleActive: Boolean(nowPlaying.isShuffleActive),
      repeatMode: String(nowPlaying.autoRepeatMode || "none").toLowerCase(),
      queuePreviewPrevious: sidebarPreviews.previous,
      queuePreviewNext: sidebarPreviews.next,
      queueHints: {
        previous: null,
        next: null,
      },
      sessionVolumeAvailable: false,
      volume,
      stateChangedAt: this.state.stateChangedAt,
      trackChangedAt: this.state.trackChangedAt,
    };
  }

  async runFallbackScript(scriptName, additionalArgs = [], options = {}) {
    const scriptPath = path.resolve(this.pluginDir, "fallback", scriptName);
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...additionalArgs,
    ];

    const { stdout } = await execFile(this.powerShellPath, args, {
      windowsHide: true,
      timeout: options.timeoutMs || 7000,
      maxBuffer: 1024 * 1024,
    });

    return JSON.parse(stdout.trim() || "{}");
  }

  async pollFallback() {
    const payload = await this.runFallbackScript("read-gsmtc.ps1", ["-AppFilter", "TIDAL"]);
    const volume = await this.getVolumeState();

    if (!payload.ok || !payload.active) {
      return {
        ...createEmptyState(),
        bridge: "powershell",
        sampledAt: Date.now(),
        volume,
      };
    }

    const playbackStatus = String(payload.playbackStatus || "stopped").toLowerCase();
    const durationMs = roundMilliseconds(payload.durationMs);
    const positionMs = roundMilliseconds(payload.positionMs);

    return {
      bridge: "powershell",
      active: true,
      hasMedia: Boolean(payload.title || payload.artist || durationMs),
      appId: payload.appId || "",
      title: payload.title || "",
      artist: payload.artist || "",
      album: payload.album || "",
      trackId: this.buildTrackId({
        appId: payload.appId,
        title: payload.title,
        artist: payload.artist,
        album: payload.album,
        durationMs,
      }),
      durationMs,
      positionMs,
      sampledAt: Date.now(),
      playbackStatus,
      isPlaying: playbackStatus === "playing",
      isPaused: playbackStatus === "paused",
      artworkPath: payload.artworkPath || "",
      artworkHash: payload.artworkHash || "",
      artworkContentType: payload.artworkContentType || "",
      artworkCandidates: payload.artworkPath
        ? [{
          artworkPath: payload.artworkPath || "",
          artworkHash: payload.artworkHash || "",
          artworkContentType: payload.artworkContentType || "",
          source: "gsmtc",
        }]
        : [],
      shuffleActive: false,
      repeatMode: "none",
      queuePreviewPrevious: null,
      queuePreviewNext: null,
      queueHints: {
        previous: null,
        next: null,
      },
      sessionVolumeAvailable: false,
      volume,
      stateChangedAt: this.state.stateChangedAt,
      trackChangedAt: this.state.trackChangedAt,
    };
  }

  canUseSessionVolume() {
    try {
      return Boolean(this.native?.addon?.isAppVolumeEnabled?.());
    } catch (error) {
      return false;
    }
  }

  async getVolumeState() {
    if (this.native?.media && typeof this.native.media.getVolume === "function") {
      try {
        const response = this.native.media.getVolume();
        const mute = typeof this.native.media.getMuted === "function" ? this.native.media.getMuted() : false;
        if (response?.ok) {
          return {
            value: Math.max(0, Math.min(100, Math.round(Number(response.volumePercent ?? response.volume * 100) || 0))),
            muted: Boolean(mute),
            source: "system",
          };
        }
      } catch (error) {
        this.logger.warn("native-master-volume-read-failed", { error: error.message });
      }
    }

    try {
      const [value, muted] = await Promise.all([loudness.getVolume(), loudness.getMuted()]);
      return {
        value: Math.max(0, Math.min(100, Math.round(Number(value) || 0))),
        muted: Boolean(muted),
        source: "system",
      };
    } catch (error) {
      this.logger.warn("loudness-read-failed", { error: error.message });
      return {
        value: this.state.volume.value || 0,
        muted: this.state.volume.muted || false,
        source: "system",
      };
    }
  }

  async changeVolume(deltaPercent) {
    const current = await this.getVolumeState();
    const nextValue = Math.max(0, Math.min(100, Math.round(current.value + deltaPercent)));

    if (this.native?.media && typeof this.native.media.setVolume === "function") {
      this.native.media.setVolume(nextValue / 100);
      if (typeof this.native.media.setMuted === "function" && current.muted && nextValue > 0) {
        this.native.media.setMuted(false);
      }
    } else {
      await loudness.setVolume(nextValue);
      if (current.muted && nextValue > 0) {
        await loudness.setMuted(false);
      }
    }

    const updated = await this.getVolumeState();
    this.state.volume = updated;
    this.emit("volume", updated);
    return updated;
  }

  async toggleMute() {
    const current = await this.getVolumeState();
    const nextMuted = !current.muted;

    if (this.native?.media && typeof this.native.media.setMuted === "function") {
      this.native.media.setMuted(nextMuted);
    } else {
      await loudness.setMuted(nextMuted);
    }

    const updated = await this.getVolumeState();
    this.state.volume = updated;
    this.emit("volume", updated);
    return updated;
  }

  async transport(actionName) {
    if (this.native?.addon) {
      switch (actionName) {
        case "togglePlayPause":
          this.native.addon.togglePlayPause();
          break;
        case "nextTrack":
          this.native.addon.nextTrack();
          break;
        case "previousTrack":
          this.native.addon.prevTrack();
          break;
        default:
          break;
      }
    } else {
      await this.runFallbackScript("gsmtc-control.ps1", ["-AppFilter", "TIDAL", "-Action", actionName]);
    }

    setTimeout(() => {
      void this.pollNow(`transport:${actionName}`);
    }, 120);

    setTimeout(() => {
      void this.pollNow(`transport-followup:${actionName}`);
    }, 420);

    setTimeout(() => {
      void this.pollNow(`transport-settled:${actionName}`);
    }, 900);
  }

  async togglePlayPause() {
    return this.transport("togglePlayPause");
  }

  async nextTrack() {
    return this.transport("nextTrack");
  }

  async previousTrack() {
    return this.transport("previousTrack");
  }

  getSnapshot(now = Date.now()) {
    const positionMs = this.state.isPlaying
      ? Math.min(this.state.durationMs || Number.MAX_SAFE_INTEGER, Math.max(0, this.state.positionMs + (now - this.state.sampledAt)))
      : this.state.positionMs;

    return {
      ...this.state,
      positionMs,
      progress: this.state.durationMs > 0 ? Math.max(0, Math.min(1, positionMs / this.state.durationMs)) : 0,
      now,
      debugText: `${this.state.bridge}:${Math.round(this.state.volume.value)}%`,
    };
  }
}

module.exports = {
  MediaSession,
};
