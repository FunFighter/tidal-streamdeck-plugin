"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createCanvas, loadImage } = require("@napi-rs/canvas");

const ARTWORK_SAMPLE_SIZE = 16;
const MIN_OPAQUE_RATIO = 0.7;
const VERY_DARK_LUMA = 18;
const NON_DARK_LUMA = 42;
const MAX_BLACK_AVERAGE_LUMA = 10;
const MAX_BLACK_STD_DEV = 8;
const MAX_BLACK_MAX_LUMA = 28;
const MIN_NON_DARK_RATIO = 0.01;
const MAX_FLAT_COLOR_STD_DEV = 7;
const MAX_FLAT_CHANNEL_SPREAD = 20;
const MAX_FLAT_BUCKET_COUNT = 3;
const MIN_DOMINANT_BUCKET_RATIO = 0.92;

class AlbumArtCache {
  constructor({ pluginDir, logger, memoryLimit = 48, diskLimit = 160 }) {
    this.logger = logger;
    this.memoryLimit = memoryLimit;
    this.diskLimit = diskLimit;
    this.memory = new Map();
    this.artworkDir = path.resolve(pluginDir, "..", "cache", "artwork");

    fs.mkdirSync(this.artworkDir, { recursive: true });
  }

  buildKey(snapshot) {
    if (!snapshot || !snapshot.hasMedia) {
      return null;
    }

    if (snapshot.artworkHash) {
      return snapshot.artworkHash;
    }

    return crypto
      .createHash("sha1")
      .update([
        snapshot.appId || "",
        snapshot.title || "",
        snapshot.artist || "",
        snapshot.album || "",
        String(snapshot.durationMs || 0),
      ].join("|"))
      .digest("hex")
      .slice(0, 12);
  }

  extensionFor(sourcePath, contentType) {
    if (sourcePath) {
      const ext = path.extname(sourcePath).toLowerCase();
      if (ext) {
        return ext;
      }
    }

    if (contentType === "image/jpeg") {
      return ".jpg";
    }

    return ".png";
  }

  findExistingPath(key) {
    try {
      const prefix = `${key}.`;
      const match = fs.readdirSync(this.artworkDir).find((name) => name.startsWith(prefix));
      return match ? path.join(this.artworkDir, match) : null;
    } catch (error) {
      this.logger.warn("artwork-cache-scan-failed", { error: error.message });
      return null;
    }
  }

  analyzeImage(image) {
    if (!image?.width || !image?.height) {
      return {
        usable: false,
        reason: "invalid-dimensions",
        stats: {
          width: image?.width || 0,
          height: image?.height || 0,
        },
      };
    }

    const canvas = createCanvas(ARTWORK_SAMPLE_SIZE, ARTWORK_SAMPLE_SIZE);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, ARTWORK_SAMPLE_SIZE, ARTWORK_SAMPLE_SIZE);
    ctx.drawImage(image, 0, 0, ARTWORK_SAMPLE_SIZE, ARTWORK_SAMPLE_SIZE);

    const { data } = ctx.getImageData(0, 0, ARTWORK_SAMPLE_SIZE, ARTWORK_SAMPLE_SIZE);
    const pixelCount = ARTWORK_SAMPLE_SIZE * ARTWORK_SAMPLE_SIZE;
    let opaqueCount = 0;
    let veryDarkCount = 0;
    let nonDarkCount = 0;
    let maxLuma = 0;
    let minRed = 255;
    let minGreen = 255;
    let minBlue = 255;
    let maxRed = 0;
    let maxGreen = 0;
    let maxBlue = 0;
    let totalLuma = 0;
    let totalLumaSquared = 0;
    const buckets = new Map();

    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3] / 255;
      if (alpha < 0.15) {
        continue;
      }

      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const luma = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
      const bucketKey = `${red >> 5}:${green >> 5}:${blue >> 5}`;
      opaqueCount += 1;
      totalLuma += luma;
      totalLumaSquared += luma * luma;
      maxLuma = Math.max(maxLuma, luma);
      minRed = Math.min(minRed, red);
      minGreen = Math.min(minGreen, green);
      minBlue = Math.min(minBlue, blue);
      maxRed = Math.max(maxRed, red);
      maxGreen = Math.max(maxGreen, green);
      maxBlue = Math.max(maxBlue, blue);
      buckets.set(bucketKey, (buckets.get(bucketKey) || 0) + 1);

      if (luma <= VERY_DARK_LUMA) {
        veryDarkCount += 1;
      }

      if (luma >= NON_DARK_LUMA) {
        nonDarkCount += 1;
      }
    }

    const opaqueRatio = opaqueCount / pixelCount;
    if (opaqueCount === 0 || opaqueRatio < 0.08) {
      return {
        usable: false,
        reason: "fully-transparent",
        stats: {
          opaqueRatio: Number(opaqueRatio.toFixed(3)),
        },
      };
    }

    const averageLuma = totalLuma / opaqueCount;
    const variance = Math.max(0, (totalLumaSquared / opaqueCount) - (averageLuma * averageLuma));
    const standardDeviation = Math.sqrt(variance);
    const veryDarkRatio = veryDarkCount / opaqueCount;
    const nonDarkRatio = nonDarkCount / opaqueCount;
    const dominantBucketCount = Math.max(0, ...buckets.values());
    const dominantBucketRatio = dominantBucketCount / opaqueCount;
    const channelSpread = Math.max(maxRed - minRed, maxGreen - minGreen, maxBlue - minBlue);
    const looksBlack =
      opaqueRatio >= MIN_OPAQUE_RATIO
      && veryDarkRatio >= 0.985
      && nonDarkRatio <= MIN_NON_DARK_RATIO
      && averageLuma <= MAX_BLACK_AVERAGE_LUMA
      && standardDeviation <= MAX_BLACK_STD_DEV
      && maxLuma <= MAX_BLACK_MAX_LUMA;
    const looksFlatColor =
      opaqueRatio >= MIN_OPAQUE_RATIO
      && standardDeviation <= MAX_FLAT_COLOR_STD_DEV
      && channelSpread <= MAX_FLAT_CHANNEL_SPREAD
      && buckets.size <= MAX_FLAT_BUCKET_COUNT
      && dominantBucketRatio >= MIN_DOMINANT_BUCKET_RATIO;
    const usable = !looksBlack && !looksFlatColor;
    const reason = looksBlack ? "solid-black-frame" : (looksFlatColor ? "flat-color-frame" : "ok");

    return {
      usable,
      reason,
      stats: {
        opaqueRatio: Number(opaqueRatio.toFixed(3)),
        veryDarkRatio: Number(veryDarkRatio.toFixed(3)),
        nonDarkRatio: Number(nonDarkRatio.toFixed(3)),
        averageLuma: Number(averageLuma.toFixed(1)),
        standardDeviation: Number(standardDeviation.toFixed(1)),
        maxLuma: Number(maxLuma.toFixed(1)),
        dominantBucketRatio: Number(dominantBucketRatio.toFixed(3)),
        bucketCount: buckets.size,
        channelSpread,
      },
    };
  }

  async loadValidatedImage(imagePath, context = {}) {
    try {
      const image = await loadImage(imagePath);
      const analysis = this.analyzeImage(image);
      if (!analysis.usable) {
        this.logger.warn("artwork-rejected", {
          path: imagePath,
          reason: analysis.reason,
          ...context,
          stats: analysis.stats,
        });
        return null;
      }

      return {
        image,
        analysis,
      };
    } catch (error) {
      this.logger.warn("artwork-load-failed", {
        error: error.message,
        path: imagePath,
        ...context,
      });
      return null;
    }
  }

  async readCachedEntry(key, cachedPath, context = {}) {
    if (!cachedPath || !fs.existsSync(cachedPath)) {
      return null;
    }

    const loaded = await this.loadValidatedImage(cachedPath, {
      stage: "cached",
      key,
      ...context,
    });

    if (!loaded) {
      await fs.promises.unlink(cachedPath).catch(() => {});
      return null;
    }

    return {
      key,
      path: cachedPath,
      image: loaded.image,
      lastAccess: Date.now(),
    };
  }

  pruneMemory() {
    if (this.memory.size <= this.memoryLimit) {
      return;
    }

    const entries = [...this.memory.entries()].sort((left, right) => left[1].lastAccess - right[1].lastAccess);
    while (entries.length > this.memoryLimit) {
      const [key] = entries.shift();
      this.memory.delete(key);
    }
  }

  async pruneDisk() {
    let files = [];
    try {
      files = await fs.promises.readdir(this.artworkDir, { withFileTypes: true });
    } catch (error) {
      this.logger.warn("artwork-disk-scan-failed", { error: error.message });
      return;
    }

    const stats = await Promise.all(
      files
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const fullPath = path.join(this.artworkDir, entry.name);
          const stat = await fs.promises.stat(fullPath);
          return { fullPath, mtimeMs: stat.mtimeMs };
        }),
    );

    stats.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const overflow = stats.slice(this.diskLimit);
    await Promise.all(
      overflow.map(async (entry) => {
        try {
          await fs.promises.unlink(entry.fullPath);
        } catch (error) {
          this.logger.warn("artwork-prune-failed", { error: error.message, path: entry.fullPath });
        }
      }),
    );
  }

  normalizeCandidates(snapshot) {
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (candidate) => {
      if (!candidate?.artworkPath) {
        return;
      }

      const dedupeKey = `${candidate.artworkHash || ""}|${candidate.artworkPath || ""}`;
      if (seen.has(dedupeKey)) {
        return;
      }

      seen.add(dedupeKey);
      candidates.push({
        artworkPath: candidate.artworkPath,
        artworkHash: candidate.artworkHash || "",
        artworkContentType: candidate.artworkContentType || "",
        source: candidate.source || "",
      });
    };

    if (Array.isArray(snapshot?.artworkCandidates)) {
      snapshot.artworkCandidates.forEach(pushCandidate);
    }

    pushCandidate(snapshot);
    return candidates;
  }

  async cacheFile(sourcePath, key, contentType, context = {}) {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return null;
    }

    const targetPath = path.join(this.artworkDir, `${key}${this.extensionFor(sourcePath, contentType)}`);
    const sourceImage = await this.loadValidatedImage(sourcePath, {
      stage: "source",
      key,
      ...context,
    });

    if (!sourceImage) {
      return null;
    }

    await fs.promises.copyFile(sourcePath, targetPath);
    const now = new Date();
    await fs.promises.utimes(targetPath, now, now).catch(() => {});
    void this.pruneDisk();

    return {
      key,
      path: targetPath,
      image: sourceImage.image,
      lastAccess: Date.now(),
    };
  }

  async getArtwork(snapshot) {
    const key = this.buildKey(snapshot);
    const candidates = this.normalizeCandidates(snapshot);
    if (!key || candidates.length === 0) {
      return null;
    }

    const cached = this.memory.get(key);
    if (cached) {
      const analysis = this.analyzeImage(cached.image);
      if (!analysis.usable) {
        this.logger.warn("artwork-memory-entry-rejected", {
          key,
          reason: analysis.reason,
          stats: analysis.stats,
        });
        this.memory.delete(key);
      } else {
        cached.lastAccess = Date.now();
        return cached;
      }
    }

    const existingPath = this.findExistingPath(key);
    for (const candidate of candidates) {
      const entry = await this.cacheFile(candidate.artworkPath, key, candidate.artworkContentType || snapshot.artworkContentType, {
        candidateSource: candidate.source || "unknown",
      });
      if (entry) {
        this.memory.set(key, entry);
        this.pruneMemory();
        return entry;
      }
    }

    const fallbackEntry = await this.readCachedEntry(key, existingPath, {
      fallbackFromCandidates: candidates.length,
    });
    if (!fallbackEntry) {
      return null;
    }

    this.memory.set(key, fallbackEntry);
    this.pruneMemory();
    return fallbackEntry;
  }
}

module.exports = {
  AlbumArtCache,
};
