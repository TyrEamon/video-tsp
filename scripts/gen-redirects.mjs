import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outputRoot = "public";
const videoRoot = join(outputRoot, "_v");
const redirectsPath = join(outputRoot, "_redirects");
const catalogPath = join(outputRoot, "catalog.json");

mkdirSync(videoRoot, { recursive: true });

const slugPattern = /^[A-Za-z0-9_-]+$/;
const redirects = [];
const warnings = [];
const redirectSet = new Set();
const catalog = [];

function addRedirect(from, to) {
  const line = `${from} ${to} 302`;
  if (!redirectSet.has(line)) {
    redirectSet.add(line);
    redirects.push(line);
  }
}

function pickManifest(files, preferredNames, extensionLabel) {
  if (files.length === 0) {
    return null;
  }

  for (const preferred of preferredNames) {
    const match = files.find((name) => name.toLowerCase() === preferred);
    if (match) {
      return match;
    }
  }

  if (files.length === 1) {
    return files[0];
  }

  return {
    error: `multiple ${extensionLabel} files (${files.join(", ")})`,
  };
}

function parseHlsManifest(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const info = {
    type: "hls",
    playlistKind: "media",
    targetDuration: null,
    totalDurationSeconds: null,
    segmentCount: 0,
    playlistType: null,
    version: null,
    codecs: [],
    resolutions: [],
    bandwidths: [],
    segmentExtensions: [],
    notes: [],
  };

  if (!lines.some((line) => line.startsWith("#EXTM3U"))) {
    info.notes.push("missing #EXTM3U header");
  }

  const extInfDurations = [];
  const codecs = new Set();
  const resolutions = new Set();
  const bandwidths = new Set();
  const segmentExts = new Set();
  let hasVariantTags = false;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      hasVariantTags = true;
      const codecMatch = line.match(/CODECS="([^"]+)"/i);
      if (codecMatch) {
        codecMatch[1]
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .forEach((codec) => codecs.add(codec));
      }
      const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
      if (resolutionMatch) {
        resolutions.add(resolutionMatch[1]);
      }
      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
      if (bandwidthMatch) {
        bandwidths.add(Number(bandwidthMatch[1]));
      }
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      hasVariantTags = true;
      const codecMatch = line.match(/CODECS="([^"]+)"/i);
      if (codecMatch) {
        codecMatch[1]
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .forEach((codec) => codecs.add(codec));
      }
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      const n = Number(line.split(":")[1]);
      info.targetDuration = Number.isFinite(n) ? n : null;
    } else if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
      info.playlistType = line.split(":")[1] ?? null;
    } else if (line.startsWith("#EXT-X-VERSION:")) {
      const n = Number(line.split(":")[1]);
      info.version = Number.isFinite(n) ? n : null;
    } else if (line.startsWith("#EXTINF:")) {
      const raw = line.slice("#EXTINF:".length).split(",")[0];
      const n = Number(raw);
      if (Number.isFinite(n)) {
        extInfDurations.push(n);
      }
    } else if (!line.startsWith("#")) {
      const ext = line.includes(".") ? line.split(".").pop().toLowerCase() : "";
      if (ext) {
        segmentExts.add(ext);
      }
    }
  }

  info.playlistKind = hasVariantTags ? "master" : "media";
  info.segmentCount = extInfDurations.length;
  if (extInfDurations.length > 0) {
    info.totalDurationSeconds = Number(
      extInfDurations.reduce((sum, item) => sum + item, 0).toFixed(3),
    );
  }

  if (codecs.size === 0 && segmentExts.has("ts")) {
    info.notes.push("codec not declared in playlist (TS media playlist)");
  }

  info.codecs = [...codecs];
  info.resolutions = [...resolutions];
  info.bandwidths = [...bandwidths].sort((a, b) => a - b);
  info.segmentExtensions = [...segmentExts];

  return info;
}

function parseIsoDurationToSeconds(value) {
  if (!value || typeof value !== "string") return null;
  const match = value.match(
    /^P(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i,
  );
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? Number(total.toFixed(3)) : null;
}

function parseDashManifest(xml) {
  const codecs = new Set();
  const mimeTypes = new Set();
  const reps = [];

  for (const match of xml.matchAll(/\bcodecs="([^"]+)"/gi)) {
    codecs.add(match[1].trim());
  }

  for (const match of xml.matchAll(/\bmimeType="([^"]+)"/gi)) {
    mimeTypes.add(match[1].trim());
  }

  for (const match of xml.matchAll(
    /<Representation\b([^>]*?)\bid="([^"]+)"([^>]*?)>/gi,
  )) {
    const fullAttrs = `${match[1]} ${match[3]}`;
    const bandwidthMatch = fullAttrs.match(/\bbandwidth="(\d+)"/i);
    const widthMatch = fullAttrs.match(/\bwidth="(\d+)"/i);
    const heightMatch = fullAttrs.match(/\bheight="(\d+)"/i);
    reps.push({
      id: match[2],
      bandwidth: bandwidthMatch ? Number(bandwidthMatch[1]) : null,
      resolution:
        widthMatch && heightMatch ? `${widthMatch[1]}x${heightMatch[1]}` : null,
    });
  }

  const durationMatch = xml.match(/\bmediaPresentationDuration="([^"]+)"/i);
  const durationSeconds = durationMatch
    ? parseIsoDurationToSeconds(durationMatch[1])
    : null;

  const segmentCountApprox = (xml.match(/<SegmentURL\b/gi) || []).length;

  return {
    type: "dash",
    totalDurationSeconds: durationSeconds,
    codecs: [...codecs],
    mimeTypes: [...mimeTypes],
    representationCount: reps.length,
    representations: reps,
    segmentCountApprox: segmentCountApprox || null,
  };
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 100 || idx === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[idx]}`;
}

function humanDuration(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

for (const entry of readdirSync(videoRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const slug = entry.name;
  const slugDir = join(videoRoot, slug);
  const fileDirents = readdirSync(slugDir, { withFileTypes: true }).filter((item) =>
    item.isFile(),
  );
  const files = fileDirents.map((item) => item.name);
  const m3u8Files = files.filter((name) => name.toLowerCase().endsWith(".m3u8"));
  const mpdFiles = files.filter((name) => name.toLowerCase().endsWith(".mpd"));

  if (!slugPattern.test(slug)) {
    warnings.push(
      `Skip "${slug}" (slug only supports letters/numbers/_/- for short URLs)`,
    );
    continue;
  }

  const hlsManifest = pickManifest(
    m3u8Files,
    ["index.m3u8", "master.m3u8"],
    ".m3u8",
  );
  const dashManifest = pickManifest(
    mpdFiles,
    ["index.mpd", "manifest.mpd"],
    ".mpd",
  );

  if (!hlsManifest && !dashManifest) {
    warnings.push(`Skip "${slug}" (missing .m3u8/.mpd file)`);
    continue;
  }

  if (hlsManifest && typeof hlsManifest !== "string") {
    warnings.push(
      `HLS alias not generated for "${slug}" (${hlsManifest.error}; rename entry to index.m3u8/master.m3u8)`,
    );
  }
  if (dashManifest && typeof dashManifest !== "string") {
    warnings.push(
      `DASH alias not generated for "${slug}" (${dashManifest.error}; rename entry to index.mpd/manifest.mpd)`,
    );
  }

  const hlsName = typeof hlsManifest === "string" ? hlsManifest : null;
  const dashName = typeof dashManifest === "string" ? dashManifest : null;

  if (!hlsName && !dashName) {
    warnings.push(
      `Skip "${slug}" (no unambiguous manifest; keep one playlist per type or use index/master/manifest names)`,
    );
    continue;
  }

  // Default short path prefers HLS when both exist for maximum player compatibility.
  if (hlsName) {
    addRedirect(`/${slug}`, `/_v/${slug}/${hlsName}`);
  } else if (dashName) {
    addRedirect(`/${slug}`, `/_v/${slug}/${dashName}`);
  }

  if (hlsName) {
    addRedirect(`/h/${slug}`, `/_v/${slug}/${hlsName}`);
  }

  if (dashName) {
    addRedirect(`/d/${slug}`, `/_v/${slug}/${dashName}`);
  }

  if (hlsName) {
    addRedirect(`/${slug}.m3u8`, `/_v/${slug}/${hlsName}`);
  }

  if (dashName) {
    addRedirect(`/${slug}.mpd`, `/_v/${slug}/${dashName}`);
  }

  const filesDetailed = fileDirents.map((file) => {
    const filePath = join(slugDir, file.name);
    const stats = statSync(filePath);
    const ext = file.name.includes(".")
      ? file.name.split(".").pop().toLowerCase()
      : "";
    return {
      name: file.name,
      ext,
      sizeBytes: stats.size,
      url: `/_v/${slug}/${file.name}`,
    };
  });

  const totalBytes = filesDetailed.reduce((sum, file) => sum + file.sizeBytes, 0);
  const extCounts = {};
  for (const file of filesDetailed) {
    extCounts[file.ext || "(none)"] = (extCounts[file.ext || "(none)"] || 0) + 1;
  }

  let hlsInfo = null;
  if (hlsName) {
    try {
      const text = readFileSync(join(slugDir, hlsName), "utf8");
      hlsInfo = {
        manifestName: hlsName,
        manifestUrl: `/_v/${slug}/${hlsName}`,
        ...parseHlsManifest(text),
      };
    } catch (error) {
      hlsInfo = {
        manifestName: hlsName,
        manifestUrl: `/_v/${slug}/${hlsName}`,
        type: "hls",
        parseError: String(error),
      };
    }
  }

  let dashInfo = null;
  if (dashName) {
    try {
      const xml = readFileSync(join(slugDir, dashName), "utf8");
      dashInfo = {
        manifestName: dashName,
        manifestUrl: `/_v/${slug}/${dashName}`,
        ...parseDashManifest(xml),
      };
    } catch (error) {
      dashInfo = {
        manifestName: dashName,
        manifestUrl: `/_v/${slug}/${dashName}`,
        type: "dash",
        parseError: String(error),
      };
    }
  }

  const defaultProtocol = hlsName ? "hls" : "dash";
  const defaultManifestUrl = hlsName
    ? `/_v/${slug}/${hlsName}`
    : dashName
      ? `/_v/${slug}/${dashName}`
      : null;

  const primaryDuration =
    hlsInfo?.totalDurationSeconds ?? dashInfo?.totalDurationSeconds ?? null;
  const primaryCodecs =
    (hlsInfo?.codecs && hlsInfo.codecs.length > 0 && hlsInfo.codecs) ||
    (dashInfo?.codecs && dashInfo.codecs.length > 0 && dashInfo.codecs) ||
    [];

  catalog.push({
    slug,
    urls: {
      default: `/${slug}`,
      hls: hlsName ? `/h/${slug}` : null,
      dash: dashName ? `/d/${slug}` : null,
      hlsManifest: hlsName ? `/${slug}.m3u8` : null,
      dashManifest: dashName ? `/${slug}.mpd` : null,
      player: `/player.html?v=${encodeURIComponent(slug)}`,
      playerHls: hlsName ? `/player.html?v=${encodeURIComponent(slug)}&type=hls` : null,
      playerDash: dashName ? `/player.html?v=${encodeURIComponent(slug)}&type=dash` : null,
    },
    protocols: {
      hls: Boolean(hlsName),
      dash: Boolean(dashName),
      defaultProtocol,
    },
    files: {
      totalCount: filesDetailed.length,
      totalBytes,
      totalSize: humanBytes(totalBytes),
      byExtension: extCounts,
      sample: filesDetailed.slice(0, 10),
    },
    summary: {
      durationSeconds: primaryDuration,
      durationText: humanDuration(primaryDuration),
      codecs: primaryCodecs,
      codecText: primaryCodecs.length ? primaryCodecs.join(", ") : "unknown",
      hlsSegmentCount: hlsInfo?.segmentCount ?? null,
      dashRepresentationCount: dashInfo?.representationCount ?? null,
    },
    analysis: {
      hls: hlsInfo,
      dash: dashInfo,
    },
    manifests: {
      default: defaultManifestUrl,
      hls: hlsName ? `/_v/${slug}/${hlsName}` : null,
      dash: dashName ? `/_v/${slug}/${dashName}` : null,
    },
  });
}

redirects.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
catalog.sort((a, b) => a.slug.localeCompare(b.slug, "en", { numeric: true }));

writeFileSync(redirectsPath, redirects.join("\n") + (redirects.length ? "\n" : ""), "utf8");
writeFileSync(
  catalogPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      basePath: "/_v",
      videoCount: catalog.length,
      items: catalog,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log(`Generated ${redirects.length} redirects -> ${redirectsPath}`);
console.log(`Generated catalog (${catalog.length} videos) -> ${catalogPath}`);
for (const warning of warnings) {
  console.warn(warning);
}
