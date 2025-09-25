#!/usr/bin/env node

const VERSION = require('./package.json').version;
const express = require('express');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
// const util = require('util');

/** @type {string} */
const tmpdir = require('os').tmpdir();
const ytDlpWrap = new YTDlpWrap();
/** @type {number} */
const PORT = process.env.PORT || 7000;
const prefix = 'yt_id:';
const reversedPrefix = 'Reversed';
const channelRegex = /^(https:\/\/www\.youtube\.com\/)?(?<id>@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9])/;
const channelIDRegex = /^(https:\/\/www\.youtube\.com\/channel\/)?(?<id>UC[A-Za-z0-9_-]{21}[AQgw])/
const playlistIDRegex = /^(https:\/\/www\.youtube\.com\/playlist\?list=)?(?<id>PL([0-9A-F]{16}|[A-Za-z0-9_-]{32}))/;
const videoIDRegex = /^(https:\/\/www\.youtube\.com\/watch\?v=)?(?<id>[A-Za-z0-9_-]{10}[AEIMQUYcgkosw048])/;
const channelTypeArray = [
    'auto',
    'video',
    'channel'
];
const defaultCatalogType = 'YouTube';
const termKeyword = '{term}';
const sortKeyword = '{sort}';

/** @type {Buffer} */
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ? Buffer.from(process.env.ENCRYPTION_KEY, 'base64') : crypto.randomBytes(32);
const ALGORITHM = 'aes-256-gcm';

const extractors = ytDlpWrap.getExtractors();
/** @type {Promise<string>} */
const supportedWebsites = new Promise(async resolve =>
    resolve(`<ul style="list-style-type: none;">${(await extractors).map(extractor => '<li>' + extractor + '</li>').join('')}</ul>`)
);

/** Encrypts text using AES-256-GCM 
 * @param {string} text
 * @returns {string}
*/
function encrypt(text) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
        ALGORITHM,
        crypto.createHash('sha256').update(Buffer.concat([ENCRYPTION_KEY, salt])).digest(),
        iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return salt.toString('hex') + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

/**
 * Decrypts text encrypted with AES-256-GCM
 * @param {string} encryptedData 
 * @returns {string}
 */
function decrypt(encryptedData) {
    const parts = encryptedData.split(':');
    if (parts.length !== 4) throw new Error('Invalid encrypted data format');
    const salt = Buffer.from(parts[0], 'hex');
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encrypted = parts[3];
    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        crypto.createHash('sha256').update(Buffer.concat([ENCRYPTION_KEY, salt])).digest(),
        iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

let counter = 0;
/**
 * Runs yt-dlp with authentication
 * @param {string} encryptedConfig 
 * @param {string[]} argsArray 
 * @returns {Promise<Object>}
 */
async function runYtDlpWithAuth(encryptedConfig, argsArray) {
    let filename = '';
    try {
        /** @type {Object?} */
        const auth = decryptConfig(encryptedConfig).encrypted?.auth;
        // Implement better auth system
        const cookies = auth;
        /** @type {string} */
        filename = cookies ? path.join(tmpdir, `cookies-${Date.now()}-${counter++}.txt`) : '';
        counter %= Number.MAX_SAFE_INTEGER;
        if (filename) await fs.writeFile(filename, cookies);
        return JSON.parse(await ytDlpWrap.execPromise([
            ...argsArray,
            '-i',
            '--no-plugin-dirs',
            '--flat-playlist',
            '--no-cache-dir',
            '--no-warnings',
            '--ignore-no-formats-error',
            '-J',
            '--ies', process.env.YTDLP_EXTRACTORS ?? 'all',
            '--extractor-args', 'generic:impersonate',
            '--compat-options', 'no-youtube-channel-redirect',
            ...(cookies ? ['--cookies', filename] : [])
        ]));
    } finally {
        try {
            if (filename) await fs.unlink(filename);
        } catch (error) { }
    }
}

/**
 * @typedef {{
 * titles: Array<{
 * title: string,
 * original: boolean,
 * votes: number,
 * locked: boolean,
 * UUID: string,
 * userID: string
 * }>,
 * thumbnails: Array<{
 * timestamp: number,
 * original: boolean,
 * votes: number,
 * locked: boolean,
 * UUID: string,
 * userID: string
 * }>,
 * randomTime: number,
 * videoDuration: number | null
 * }} DeArrowResponse
 */

/**
 * Get DeArrow branding data
 * @param {string} videoID 
 * @returns {Promise<DeArrowResponse?>}
 */
async function runDeArrow(videoID) {
    if (process.env.NO_DEARROW) return null;
    return await (await fetch('https://sponsor.ajay.app/api/branding?videoID=' + videoID)).json();
}

/**
 * Get DeArrow thumbnail URL
 * @param {string} videoID 
 * @param {number} time 
 * @returns {string}
 */
function getDeArrowThumbnail(videoID, time) {
    return `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${videoID}&time=${time}`;
}

/**
 * @typedef {Array<{
 * segment: [number, number],
 * UUID: string,
 * category: string,
 * videoDuration: number,
 * actionType: string,
 * locked: number,
 * votes: number,
 * description: string
 * }>} SponsorBlockSegment
 */

/**
 * Get SponsorBlock segments for a video
 * @param {string} videoID
 * @returns {Promise<SponsorBlockSegment>}
 */
async function getSponsorBlockSegments(videoID) {
    if (process.env.NO_SPONSORBLOCK) return [];
    return await (await fetch('https://sponsor.ajay.app/api/skipSegments?videoID=' + videoID)).json();
}

/**
 * Filters an m3u8 playlist by timestamp ranges
 * @param {string} url - Playlist URL
 * @param {Array<[number, number]>} ranges - [[start, end], ...]
 * @param {boolean} overestimate - Remove partially overlapping segments if true
 * @returns {Promise<string>} Data URL of filtered playlist
 */
async function cutM3U8(url, ranges = [], overestimate = false) {
    if (!ranges.length || process.env.NO_SPONSORBLOCK) return url;
    const lines = (await (await fetch(url)).text()).split('\n');
    let time = 0;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            const segStart = time;
            const segEnd = time + parseFloat(line.split(':')[1]);
            time = segEnd;
            if (!ranges.some(([start, end]) =>
                overestimate
                    ? !(segEnd <= start || segStart >= end)
                    : segStart >= start && segEnd <= end
            )) {
                out.push(line);
                out.push((lines[i + 1] || '').trim());
            }
            i++;  // skip URI line
        } else if (line) out.push(line);
    }
    return out.join('\n');
}

const app = express();
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS')
        return res.sendStatus(204);
    return next();
});

app.get('/stream/:url', async (req, res, next) => {
    try {
        res.set('Content-Type', 'application/x-mpegURL');
        return res.send(await cutM3U8(req.params.url, JSON.parse(req.params.ranges ?? '[]')));
    } catch (err) {
        res.status(500).send('Cutting stream failed');
        return next(error);
    }
});

// Config Encryption Endpoint
app.post('/encrypt', (req, res, next) => {
    try {
        return res.send(encrypt(JSON.stringify(req.body)));
    } catch (error) {
        res.status(500).send('Encryption failed');
        return next(error);
    }
});

function logError(error) {
    if (process.env.DEV_LOGGING) console.error(error);
}

// Config Decryption
/**
 * Parse a config parameter, decrypting if necessary
 * @param {string} configParam 
 * @param {boolean=true} enableDecryption 
 * @returns {Object}
 */
function decryptConfig(configParam, enableDecryption = true) {
    /** @type {Object} */
    const config = JSON.parse(configParam);
    if (enableDecryption && config.encrypted) {
        try {
            config.encrypted = JSON.parse(decrypt(config.encrypted));
        } catch (error) {
            // logError(error);
            config.encrypted = undefined;
        }
    }
    config.catalogs?.forEach(c => c.channelType = /[0-9]+/.test(c.channelType) ? channelTypeArray[c.channelType] : c.channelType);
    return config;
}

/**
 * Tests whether a string is a valid URL
 * @param {string} s 
 * @returns {boolean}
 */
function isURL(s) {
    try {
        return Boolean(new URL(s));
    } catch {
        return false;
    }
}

// Stremio Addon Manifest Route
app.get('/:config/manifest.json', (req, res, next) => {
    try {
        const userConfig = decryptConfig(req.params.config, false);
        const canGenre = /** @param {Object} c */ (c) => {
            if (c.channelType !== 'auto') return true;
            const id = c.id?.startsWith(prefix) ? c.id.slice(prefix.length) : c.id ?? '';
            if ([':ytfav', ':ytwatchlater', ':ytsubs', ':ythistory', ':ytrec', ':ytnotif'].includes(id)) return false;
            if (channelRegex.test(id)) return false;
            if (channelIDRegex.test(id)) return false;
            if (playlistIDRegex.test(id)) return false;
            if (videoIDRegex.test(id)) return false;
            if ([':ytsearch', ':ytsearch:channel'].includes(id)) return true;
            if (id.startsWith('https://www.youtube.com/results?search_query=')) return true;
            return !isURL(id);
        }
        const catalogs = [
            ...(userConfig.catalogs?.map(c => ({
                ...c, extra: [
                    ...(c.extra ?? []),
                    ...(c.channelType === 'auto' &&
                        (c.id.includes(termKeyword) || [':ytsearch', ':ytsearch:channel'].includes(c.id.startsWith(prefix) ? c.id.slice(prefix.length) : c.id)) ?
                        [{ name: 'search', isRequired: true }] : [])
                ]
                // Add defaults if cookies were provided
            })) ?? (userConfig.encrypted ? [
                { id: ':ytrec', name: 'Discover' },
                { id: ':ytsubs', name: 'Subscriptions' },
                { id: ':ytwatchlater', name: 'Watch Later' },
                { id: ':ythistory', name: 'History' }
                // Add search unless explicitly disabled
            ] : [])), ...((userConfig.search ?? true) ? [
                { id: ':ytsearch', name: 'Video' },
                { id: ':ytsearch:channel', name: 'Channel' }
            ] : []).map(c => ({
                ...c, extra: [
                    ...(c.extra ?? []),
                    { name: 'search', isRequired: true },
                ]
            }))
        ].map(c => ({
            ...c,
            id: c.id?.startsWith(prefix) ? c.id : prefix + (c.id ?? ''),
            type: c.type ?? userConfig.catalogType ?? defaultCatalogType,
            extra: [
                ...(
                    c.extra ?? []
                ), {
                    name: 'genre',
                    isRequired: false,
                    options: [
                        '',
                        // Add YouTube sorting options if none provided
                        ...(c.sortOrder?.map(s => s.name) ?? (canGenre(c) ? ['Relevance', 'Upload Date', 'View Count', 'Rating'] : []))
                    ].flatMap(x => [x, `${reversedPrefix} ${x}`.trim()])  // Create reversed of each option
                        .slice(1)  // Remove default sorting option
                }, {
                    name: 'skip',
                    isRequired: false
                }
            ]
        }));
        return res.json({
            id: 'youtubio.elfhosted.com',
            version: VERSION,
            name: 'YouTubio | ElfHosted',
            description: 'Watch YouTube videos, subscriptions, watch later, and history in Stremio.',
            resources: ['catalog', 'stream', 'meta'],
            types: [...new Set(catalogs.map(c => c.type))],
            idPrefixes: [prefix],
            catalogs,
            logo: `https://github.com/xXCrash2BomberXx/YouTubio/blob/${process.env.DEV_LOGGING ? 'main' : `v${VERSION}`}/icon.png?raw=true`,
            behaviorHints: {
                configurable: true
            },
            stremioAddonsConfig: {
                issuer: "https://stremio-addons.net",
                signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..tLliZZqbqp8DSpNFCa_o7g.1Zu-sGRA8Xmc-qG9d_ctvcvrbtBFdVH8Kqmj9RL-ONB5C5iiy5qITOH3Z1nrTfQuiIhwJyQuU0npD0S8lYtv5InjpulZHYQDdBJpPnTvn1jqwM4AgDPCpm05lNLYW3Kp.IpryYoO1JqXwFBmkHrD3OA"
            }
        });
    } catch (error) {
        res.json({});
        return next(error);
    }
});

/**
 * Converts a YouTube video ID and query parameters into a YouTube URL.
 * @param {Object} userConfig 
 * @param {string} videoId 
 * @param {Object} query 
 * @returns {string}
 */
function toYouTubeURL(userConfig, videoId, query) {
    /** @type {RegExpMatchArray?} */
    let temp;
    const catalogConfig = userConfig.catalogs?.find(cat => videoId === cat.id) ?? {};
    if (videoId.startsWith(prefix)) videoId = videoId.slice(prefix.length);
    /** @type {string} */
    const genre = (query.genre?.startsWith(reversedPrefix) ? query.genre.slice(reversedPrefix.length) : query.genre)?.trim() ?? 'Relevance';
    if (catalogConfig.channelType === 'video' || videoId === ':ytsearch')
        return `https://www.youtube.com/results?search_query=${encodeURIComponent(query.search ?? '')}&sp=${{
            'Relevance': 'CAASAhAB',
            'Upload Date': 'CAISAhAB',
            'View Count': 'CAMSAhAB',
            'Rating': 'CAESAhAB'
        }[genre]}`;
    else if (catalogConfig.channelType === 'channel' || videoId === ':ytsearch:channel')
        return `https://www.youtube.com/results?search_query=${encodeURIComponent(query.search ?? '')}&sp=${{
            'Relevance': 'CAASAhAC',
            'Upload Date': 'CAISAhAC',
            'View Count': 'CAMSAhAC',
            'Rating': 'CAESAhAC'
        }[genre]}`;
    else if ([termKeyword, sortKeyword].some(keyword => catalogConfig.id?.includes(keyword)))
        return (catalogConfig.id.startsWith(prefix) ? catalogConfig.id.slice(prefix.length) : catalogConfig.id)
            .replaceAll(termKeyword, encodeURIComponent(query.search ?? ''))
            .replaceAll(sortKeyword, catalogConfig.sortOrder?.find(s => s.name === genre)?.id ?? '');
    else if ([':ytfav', ':ytwatchlater', ':ytsubs', ':ythistory', ':ytrec', ':ytnotif'].includes(videoId))
        return videoId;
    else if ((temp = videoId.match(channelRegex)?.groups.id))
        return `https://www.youtube.com/${temp}/videos`;
    else if ((temp = videoId.match(channelIDRegex)?.groups.id))
        return `https://www.youtube.com/channel/${temp}/videos`;
    else if ((temp = videoId.match(playlistIDRegex)?.groups.id))
        return 'https://www.youtube.com/playlist?list=' + temp;
    else if ((temp = videoId.match(videoIDRegex)?.groups.id))
        return 'https://www.youtube.com/watch?v=' + temp;
    else if (isURL(videoId))
        return videoId;
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(videoId)}&sp=${{
        'Relevance': 'CAASAhAB',
        'Upload Date': 'CAISAhAB',
        'View Count': 'CAMSAhAB',
        'Rating': 'CAESAhAB'
    }[genre]}`;
}

// Stremio Addon Catalog Route
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res, next) => {
    try {
        if (!req.params.id?.startsWith(prefix)) throw new Error(`Unknown ID in Catalog handler: "${req.params.id}"`);
        const userConfig = decryptConfig(req.params.config, false);
        const query = Object.fromEntries(new URLSearchParams(req.params.extra ?? ''));
        const skip = parseInt(query.skip ?? 0);
        const videos = await runYtDlpWithAuth(req.params.config, [
            '-I', query.genre?.startsWith(reversedPrefix) ? `${-(skip + 1)}:${-(skip + 100)}:-1` : `${skip + 1}:${skip + 100}:1`,
            '--yes-playlist',
            toYouTubeURL(userConfig, req.params.id, query)
        ]);
        const useID = videos.webpage_url_domain === 'youtube.com';
        const playlist = videos._type === 'playlist';
        return res.json({
            metas: (await Promise.all((playlist ? videos.entries : [videos]).map(async video => {
                const channel = useID && (channelRegex.test(video.id) || channelIDRegex.test(video.id));
                const deArrow = useID && videoIDRegex.test(video.id) && userConfig.dearrow ? await runDeArrow(video.id) : null;
                /** @type {string?} */
                const thumbnail = (deArrow?.thumbnails[0] ?
                    getDeArrowThumbnail(video.id, deArrow.thumbnails[0].timestamp) :
                    null) ?? video.thumbnail ?? video.thumbnails?.at(-1)?.url;
                return {
                    id: useID ? prefix + video.id : playlist ? prefix + video.url : req.params.id,
                    type: req.params.type,
                    name: deArrow?.titles[0]?.title ?? video.title ?? 'Unknown Title',
                    poster: thumbnail ? (channel ? 'https:' : '') + thumbnail : undefined,
                    posterShape: channel ? 'square' : 'landscape',
                    description: video.description ?? video.title,
                    releaseInfo: parseInt(video.release_year ?? video.upload_date?.substring(0, 4))
                };
            }))).filter(meta => meta !== null),
            behaviorHints: { cacheMaxAge: 0 }
        });
    } catch (error) {
        res.json({ metas: [] });
        return next(error);
    }
});

async function parseStream(userConfig, video, manifestUrl, protocol, reqProtocol, reqHost) {
    const ranges = (await getSponsorBlockSegments(video.id)).filter(s => userConfig.sponsorblock?.includes(s.category)).map(s => s.segment);
    const subtitles = userConfig.subtitles ?? true ? Object.entries(video.subtitles ?? {}).map(([k, v]) => {
        const srt = v.find(x => x.ext == 'srt') ?? v[0];
        return srt ? {
            id: srt.name,
            url: srt.url,
            lang: k
        } : null;
    }).concat(
        Object.entries(video.automatic_captions ?? {}).map(([k, v]) => {
            const srt = v.find(x => x.ext == 'srt') ?? v[0];
            return srt ? {
                id: `Auto ${srt.name}`,
                url: srt.url,
                lang: k
            } : null;
        })
    ).filter(srt => srt !== null) : undefined;
    const useID = video.webpage_url_domain === 'youtube.com';
    return [
        ...await Promise.all((video.formats ?? [video]).filter(src => (userConfig.showBrokenLinks || (!src.format_id?.startsWith('sb') && src.acodec !== 'none' && src.vcodec !== 'none')) && src.url).toReversed().map(async src => ({
            name: `YT-DLP Player ${src.resolution}`,
            url: src.protocol === 'm3u8_native' ? `${reqProtocol}://${reqHost}/stream/${encodeURIComponent(src.url)}?ranges=${encodeURIComponent(JSON.stringify(ranges))}` : src.url,
            description: src.format,
            subtitles,
            behaviorHints: {
                bingeGroup: `YT-DLP Player ${src.resolution}`,
                ...(src.protocol !== 'https' || src.video_ext !== 'mp4' ? { notWebReady: true } : {}),
                videoSize: src.filesize_approx,
                filename: video.filename
            }
        }))), ...(useID && (((video.is_live ?? false) && channelIDRegex.test(video.id)) || videoIDRegex.test(video.id)) ? [
            {
                name: 'Stremio Player',
                ytId: video.id,
                description: 'Click to watch using Stremio\'s built-in YouTube Player',
                subtitles,
                behaviorHints: {
                    bingeGroup: 'Stremio Player',
                    filename: video.filename
                }
            }, {
                name: 'External Player',
                externalUrl: video.webpage_url,
                description: 'Click to watch in the External Player'
            }
        ] : []), ...(video.channel_url ? [
            {
                name: 'YT-DLP Channel',
                externalUrl: `${protocol}/discover/${manifestUrl}/${userConfig.catalogType ?? defaultCatalogType}/${encodeURIComponent(prefix + (useID ? video.channel_id : video.channel_url))}`,
                description: 'Click to open the channel as a Catalog'
            }, {
                name: 'External Channel',
                externalUrl: video.channel_url,
                description: 'Click to open the channel in the External Player'
            }
        ] : [])
    ];
}

// Stremio Addon Meta Route
app.get('/:config/meta/:type/:id.json', async (req, res, next) => {
    try {
        if (!req.params.id?.startsWith(prefix)) throw new Error(`Unknown ID in Meta handler: "${req.params.id}"`);
        const userConfig = decryptConfig(req.params.config, false);
        const video = await runYtDlpWithAuth(req.params.config, [
            userConfig.markWatchedOnLoad ? '--mark-watched' : '--no-mark-watched',
            '-I', userConfig.showVideosInChannel ?? true ? ':100' : ':1',
            '--no-playlist',
            toYouTubeURL(userConfig, req.params.id, {})
        ]);
        const useID = video.webpage_url_domain === 'youtube.com';
        const channel = useID && (channelRegex.test(video.id) || channelIDRegex.test(video.id));
        const deArrow = useID && videoIDRegex.test(video.id) && userConfig.dearrow ? await runDeArrow(video.id) : null;
        /** @type {string} */
        const title = deArrow?.titles[0]?.title ?? video.title ?? 'Unknown Title';
        /** @type {string?} */
        const thumbnail = (deArrow?.thumbnails[0] ?
            getDeArrowThumbnail(video.id, deArrow.thumbnails[0].timestamp) :
            null) ?? video.thumbnail ?? video.thumbnails?.at(-1)?.url;
        /** @type {string} */
        const released = new Date(video.release_timestamp ? video.release_timestamp * 1000 : video.upload_date ? `${video.upload_date.substring(0, 4)}-${video.upload_date.substring(4, 6)}-${video.upload_date.substring(6, 8)}T00:00:00Z` : 0).toISOString();
        const manifestUrl = encodeURIComponent(`${req.protocol}://${req.get('host')}/${encodeURIComponent(req.params.config)}/manifest.json`);
        /** @type {string?} */
        const ref = req.get('Referrer');
        const protocol = ref ? ref + '#' : 'stremio://';
        const live = (userConfig.showLiveInChannel ?? true) && channel ? await runYtDlpWithAuth(req.params.config, [
            userConfig.markWatchedOnLoad ? '--mark-watched' : '--no-mark-watched',
            '-I', ':1',
            '--no-playlist',
            `https://www.youtube.com/channel/${video.id}/live`
        ]) : undefined;
        let episode = 0;
        return res.json({
            meta: {
                id: req.params.id,
                type: req.params.type,
                name: title,
                genres: video.tags,
                poster: thumbnail,
                posterShape: channel ? 'square' : 'landscape',
                background: thumbnail,
                logo: thumbnail,
                description: video.description ?? title,
                releaseInfo: parseInt(video.release_year ?? video.upload_date?.substring(0, 4)),
                released,
                videos: [
                    ...await Promise.all([video, ...(live?.is_live ? [live] : [])].map(async video2 => ({
                        id: `${req.params.id}:1:${++episode}`,
                        title: episode === 1 ? 'Channel Options' : video2.title,
                        released,
                        thumbnail,
                        streams: await parseStream(userConfig, video2, manifestUrl, protocol, req.protocol, req.get('host')),
                        episode,
                        season: 1,
                        overview: episode === 1 ? 'Open the channel as a catalog' : video2.description ?? video2.title
                    }))), ...(((userConfig.showVideosInChannel ?? true) ? video.entries : [])?.map(x => ({
                        id: prefix + x.id,
                        title: x.title,
                        released: new Date(x.release_timestamp ? x.release_timestamp * 1000 : x.upload_date ? `${x.upload_date.substring(0, 4)}-${x.upload_date.substring(4, 6)}-${x.upload_date.substring(6, 8)}T00:00:00Z` : 0).toISOString(),
                        thumbnail: x.thumbnail ?? x.thumbnails?.at(-1)?.url,
                        episode: ++episode,
                        season: 1
                    })) ?? [])
                ],
                runtime: `${Math.floor((video.duration ?? 0) / 60)} min`,
                language: video.language,
                website: video.webpage_url,
                ...(video._type === 'playlist' ? {} : { behaviorHints: { defaultVideoId: req.params.id + ':1:1' } })
            }
        });
    } catch (error) {
        res.json({ meta: {} });
        return next(error);
    }
});

// Stremio Addon Stream Route
app.get('/:config/stream/:type/:id.json', async (req, res, next) => {
    try {
        if (!req.params.id?.startsWith(prefix)) throw new Error(`Unknown ID in Stream handler: "${req.params.id}"`);
        const userConfig = decryptConfig(req.params.config, false);
        const video = await runYtDlpWithAuth(req.params.config, [
            userConfig.markWatchedOnLoad ? '--mark-watched' : '--no-mark-watched',
            '--no-playlist',
            toYouTubeURL(userConfig, req.params.id, {})
        ]);
        const manifestUrl = encodeURIComponent(`${req.protocol}://${req.get('host')}/${encodeURIComponent(req.params.config)}/manifest.json`);
        /** @type {string?} */
        const ref = req.get('Referrer');
        const protocol = ref ? ref + '#' : 'stremio://';
        return res.json({
            streams: parseStream(userConfig, video, manifestUrl, protocol, req.protocol, req.get('host'))
        });
    } catch (error) {
        res.json({ streams: [] });
        return next(error)
    }
});

// Configuration Page
app.get(['/', '/:config?/configure'], async (req, res) => {
    /** @type {Object?} */
    let userConfig;
    try {
        userConfig = req.params.config ? decryptConfig(req.params.config, false) : {};
    } catch (error) {
        logError(error)
        userConfig = {};
    }
    const catalogType = JSON.stringify(userConfig.catalogType ?? defaultCatalogType);
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <link href="https://fonts.googleapis.com/css2?family=Ubuntu&display=swap" rel="stylesheet">
            <title>YouTubio | ElfHosted</title>
            <style>
                body { font-family: 'Ubuntu', Helvetica, Arial, sans-serif; text-align: center; padding: 2rem; background: #f4f4f8; color: #333; }
                .container { max-width: 50rem; margin: auto; background: white; padding: 2rem; border-radius: 1rem; }
                h1 { color: #d92323; }
                textarea { width: 100%; height: 15rem; padding: 1rem; border-radius: 1rem; border: 0.1rem solid #ccc; box-sizing: border-box; resize: vertical; }
                th, td { border: 0.1rem solid #ccc; padding: 1rem; text-align: left; }
                input { width: 100%; box-sizing: border-box; }
                .install-button { margin-top: 1rem; border-width: 0; display: inline-block; padding: 0.5rem; background-color: #5835b0; color: white; border-radius: 0.2rem; cursor: pointer; }
                .install-button:hover { background-color: #4a2c93; }
                .install-button:disabled { background-color: #ccc; cursor: not-allowed; }
                .error { color: #d92323; margin-top: 1rem; }
                .settings-section { text-align: left; margin-top: 2rem; padding: 1rem; border: 0.1rem solid #ddd; border-radius: 1rem; background: #f9f9f9; }
                .toggle-container { display: flex; align-items: center; margin: 1rem 0; }
                .toggle-container input[type="checkbox"] { margin-right: 1rem; }
                .toggle-container label { cursor: pointer; }
                .setting-description { color: #666; }
                @media (prefers-color-scheme: dark) {
                    body { background: #121212; color: #e0e0e0; }
                    .container { background: #1e1e1e; }
                    textarea, input, select { 
                        background: #2a2a2a; 
                        color: #e0e0e0; 
                        border: 0.1rem solid #555; 
                    }
                    th, td { border: 0.1rem solid #555; }
                    .install-button { background-color: #6a5acd; }
                    .install-button:hover { background-color: #5941a9; }
                    .install-button:disabled { background-color: #555; }
                    .settings-section { background: #1e1e1e; border: 0.1rem solid #333; }
                    .setting-description { color: #aaa; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div style="display: flex; justify-content: center; margin: 1rem; align-items: center;">
                    <img src="https://github.com/xXCrash2BomberXx/YouTubio/blob/${process.env.DEV_LOGGING ? 'main' : `v${VERSION}`}/icon.png?raw=true" alt="YouTubio">
                    <h1 style="position: relative; top: 96px; left: -80px; font-size: 32px;">ElfHosted</h1>
                </div>
                <h3 style="color: #f5a623;">v${VERSION}</h3>
                ${process.env.EMBED ?? ""}
                For a quick setup guide, go to <a href="https://github.com/xXCrash2BomberXx/YouTubio#%EF%B8%8F-quick-setup-with-cookies" target="_blank" rel="noopener noreferrer">github.com/xXCrash2BomberXx/YouTubio</a>
                <form id="config-form">
                    <div class="settings-section">
                        <details style="text-align: center;">
                            <summary>
                                This addon supports FAR more than just YouTube with URLs!<br>
                                <a href="https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md" target="_blank" rel="noopener noreferrer">Read more here.</a>
                            </summary>
                            ${process.env.YTDLP_EXTRACTORS_EMBED ?? ""}
                            <div style="max-height: 20rem; overflow: auto;">
                                ${await supportedWebsites}
                            </div>
                        </details>
                    </div>
                    <div class="settings-section">
                        <h3>Cookies</h3>
                        <hr>
                        <textarea id="cookie-data" placeholder="Paste the content of your cookies.txt file here..."${userConfig.encrypted ? ` disabled>${userConfig.encrypted ?? ''}` : '>'}</textarea>
                        <button type="button" class="install-button" id="clear-cookies">Clear</button>
                    </div>
                    <div class="settings-section">
                        <h3>Playlists</h3>
                        <hr>
                        <details>
                            <summary>Advanced Usage</summary>
                            <p>
                                &#128712;
                                <b>Search Type</b> determines how the backend interprets the <b>Playlist ID / URL</b>.
                                <ul style="margin-top: 0; font-size: small;">
                                    <li><b>Auto</b>: The backend will attempt to determine the type of the input automatically.</li>
                                    <li><b>Video</b>: Treats the <b>Playlist ID / URL</b> as though it were typed directly into the YouTube search bar.</li>
                                    <li><b>Channel</b>: Treats the <b>Playlist ID / URL</b> as though it were typed directly into the YouTube search bar with the channel filter enabled.</li>
                                </ul>
                            </p>
                            <p>
                                &#128712;
                                You can use <b><code>${termKeyword}</code></b> in the <b>Playlist ID / URL</b> for custom search catalogs in places the encoded URI search component is used.
                                ex. <code>https://www.youtube.com/results?search_query=example+search</code> &rarr; <code>https://www.youtube.com/results?search_query=${termKeyword}</code>
                            </p>
                            <p>
                                &#128712;
                                You can use <b><code>${sortKeyword}</code></b> in the <b>Playlist ID / URL</b> for custom sort order in places the encoded URI sorting component is used.
                                ex. <code>https://www.youtube.com/results?search_query=example+search&sp=CAASAhAC</code> &rarr; <code>https://www.youtube.com/results?search_query=${termKeyword}${sortKeyword}</code> &amp; Sort ID: <code>&sp=CAASAhAC</code>, Sort Name: <code>Channel</code>
                            </p>
                            <hr>
                        </details>
                        <div style="margin-bottom: 1rem;">
                            <button type="button" id="add-defaults" class="install-button">Add Defaults</button>
                            <button type="button" id="remove-defaults" class="install-button">Remove Defaults</button>
                            <button type="button" id="add-playlist" class="install-button">Add Playlist</button>
                        </div>
                        <table id="playlist-table" style="width:100%;border-collapse:collapse;">
                            <thead>
                                <tr>
                                    <th>Type</th>
                                    <th>Playlist ID / URL</th>
                                    <th>Catalog Name</th>
                                    <th>Search Type</th>
                                    <th>Sort Order</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                    </div>
                    <div class="settings-section" id="addon-settings">
                        <h3>Settings</h3>
                        <hr>
                        <table>
                            <thead>
                                <tr>
                                    <th>Value</th>
                                    <th>Setting</th>
                                    <th>Description</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${process.env.NO_DEARROW ? '<!--' : ''}
                                <tr>
                                    <td><input type="checkbox" id="dearrow" name="dearrow" data-default=0 ${userConfig.dearrow ? 'checked' : ''}></td>
                                    <td><label for="dearrow">DeArrow</label></td>
                                    <td class="setting-description">Use DeArrow to fetch video thumbnails and Titles.</td>
                                </tr>
                                ${process.env.NO_DEARROW ? '-->' : ''}
                                ${process.env.NO_SPONSORBLOCK ? '<!--' : ''}
                                <tr>
                                    <td>
                                        <select name="sponsorblock" id="sponsorblock" multiple>
                                            <option value="sponsor" ${userConfig.sponsorblock?.includes('sponsor') ? 'selected' : ''}>Sponsor</option>
                                            <option value="selfpromo" ${userConfig.sponsorblock?.includes('selfpromo') ? 'selected' : ''}>Self Promo</option>
                                            <option value="interaction" ${userConfig.sponsorblock?.includes('interaction') ? 'selected' : ''}>Interaction</option>
                                            <option value="intro" ${userConfig.sponsorblock?.includes('intro') ? 'selected' : ''}>Intro</option>
                                            <option value="outro" ${userConfig.sponsorblock?.includes('outro') ? 'selected' : ''}>Outro</option>
                                            <option value="preview" ${userConfig.sponsorblock?.includes('preview') ? 'selected' : ''}>Preview</option>
                                            <option value="hook" ${userConfig.sponsorblock?.includes('hook') ? 'selected' : ''}>Hook</option>
                                            <option value="filler" ${userConfig.sponsorblock?.includes('filler') ? 'selected' : ''}>Filler</option>
                                        </select>
                                    </td>
                                    <td><label for="sponsorblock">SponsorBlock</label></td>
                                    <td class="setting-description">Use SponsorBlock to skip various video segments.</td>
                                </tr>
                                ${process.env.NO_SPONSORBLOCK ? '-->' : ''}
                                <tr>
                                    <td><input type="checkbox" id="subtitles" name="subtitles" data-default=1 ${userConfig.subtitles ?? true ? 'checked' : ''}></td>
                                    <td><label for="subtitles">Subtitles</label></td>
                                    <td class="setting-description">Enable subtitles for videos.</td>
                                </tr>
                                <tr>
                                    <td><input type="checkbox" id="showLiveInChannel" name="showLiveInChannel" data-default=1 ${userConfig.showLiveInChannel ?? true ? 'checked' : ''}></td>
                                    <td><label for="showLiveInChannel">Show Livestreams in Channel Page</label></td>
                                    <td class="setting-description">Display the channel live stream (if one is active) in the channel meta results.</td>
                                </tr>
                                <tr>
                                    <td><input type="checkbox" id="showVideosInChannel" name="showVideosInChannel" data-default=1 ${userConfig.showVideosInChannel ?? true ? 'checked' : ''}></td>
                                    <td><label for="showVideosInChannel">Show Videos in Channel Page</label></td>
                                    <td class="setting-description">Display the most recent 100 uploads in the channel meta results.</td>
                                </tr>
                                <tr>
                                    <td><input type="checkbox" id="markWatchedOnLoad" name="markWatchedOnLoad" data-default=0 ${userConfig.markWatchedOnLoad ? 'checked' : ''}></td>
                                    <td><label for="markWatchedOnLoad">Mark Watched</label></td>
                                    <td class="setting-description">Mark videos as watched in your YouTube history when you open them in Stremio. This helps keep your YouTube watch history synchronized.</td>
                                </tr>
                                <tr>
                                    <td><input type="checkbox" id="showBrokenLinks" name="showBrokenLinks" data-default=0 ${userConfig.showBrokenLinks ? 'checked' : ''}></td>
                                    <td><label for="showBrokenLinks">Show Unsupported Streams</label></td>
                                    <td class="setting-description">Return all streams found by YT-DLP, not just ones supported by Stremio.</td>
                                </tr>
                                <tr>
                                    <td><input type="checkbox" id="search" name="search" data-default=1 ${userConfig.search ?? true ? 'checked' : ''}></td>
                                    <td><label for="search">Add YouTube Search</label></td>
                                    <td class="setting-description">Add a default YouTube search catalog for videos and channels.</td>
                                </tr>
                                <tr>
                                    <td><input type="text" id="catalogType" name="catalogType" data-default=${JSON.stringify(defaultCatalogType)} value=${catalogType} style="width: 5rem;"></td>
                                    <td><label for="catalogType">YouTube Search Type</label></td>
                                    <td class="setting-description">Specify the fallback type name of catalogs.</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <button type="submit" class="install-button" id="submit-btn">Generate Install Link</button>
                    <div id="error-message" class="error" style="display:none;"></div>
                </form>
                <div id="results" style="display:none;">
                    <h2>Install your addon</h2>
                    <a href="#" target="_blank" id="install-stremio" class="install-button">Stremio</a>
                    <a href="#" target="_blank" id="install-web" class="install-button">Stremio Web</a>
                    <a id="copy-btn" class="install-button">Copy URL</a>
                    <a href="#" id="reload" class="install-button">Reload</a>
                    <input type="text" id="install-url" style="display: none;" readonly class="url-input">
                </div>
            </div>
            <script>
                const cookies = document.getElementById('cookie-data');
                const addDefaults = document.getElementById('add-defaults');
                const addonSettings = document.getElementById('addon-settings');
                const submitBtn = document.getElementById('submit-btn');
                const errorDiv = document.getElementById('error-message');
                const resultsDiv = document.getElementById('results');
                function configChanged() {
                    resultsDiv.style.display = 'none';
                    addDefaults.disabled = cookies.value.length <= 0;
                }
                const installStremio = document.getElementById('install-stremio');
                const installWeb = document.getElementById('install-web');
                const reload = document.getElementById('reload');
                const installUrlInput = document.getElementById('install-url');
                const playlistTableBody = document.querySelector('#playlist-table tbody');
                const defaultPlaylists = [
                    { type: ${catalogType}, id: ':ytrec', name: 'Discover', channelType: 'auto' },
                    { type: ${catalogType}, id: ':ytsubs', name: 'Subscriptions', channelType: 'auto' },
                    { type: ${catalogType}, id: ':ytwatchlater', name: 'Watch Later', channelType: 'auto' },
                    { type: ${catalogType}, id: ':ythistory', name: 'History', channelType: 'auto' }
                ];
                let playlists = ${JSON.stringify(userConfig.catalogs?.map(pl => ({
        ...pl,
        id: pl.id.startsWith(prefix) ? pl.id.slice(prefix.length) : pl.id
    })) ?? [])};
                document.getElementById('clear-cookies').addEventListener('click', () => {
                    cookies.value = "";
                    cookies.disabled = false;
                    configChanged();
                });
                cookies.addEventListener('input', configChanged);
                addonSettings.querySelectorAll("input, select").forEach(e => e.addEventListener('change', configChanged));
                function makeActions(callback, array, index) {
                    const actionsCell = document.createElement('td');
                    const upBtn = document.createElement('button');
                    upBtn.textContent = '↑';
                    upBtn.classList.add('install-button');
                    upBtn.style.margin = '0.2rem';
                    upBtn.addEventListener('click', () => {
                        if (index > 0) {
                            [array[index - 1], array[index]] = [array[index], array[index - 1]];
                            callback();
                        }
                    });
                    const downBtn = document.createElement('button');
                    downBtn.textContent = '↓';
                    downBtn.classList.add('install-button');
                    downBtn.style.margin = '0.2rem';
                    downBtn.addEventListener('click', () => {
                        if (index < array.length - 1) {
                            [array[index + 1], array[index]] = [array[index], array[index + 1]];
                            callback();
                        }
                    });
                    const removeBtn = document.createElement('button');
                    removeBtn.textContent = 'Remove';
                    removeBtn.classList.add('install-button');
                    removeBtn.style.margin = '0.2rem';
                    removeBtn.addEventListener('click', () => {
                        array.splice(index, 1);
                        callback();
                    });
                    actionsCell.appendChild(upBtn);
                    actionsCell.appendChild(downBtn);
                    actionsCell.appendChild(removeBtn);
                    return actionsCell;
                }
                function renderPlaylists() {
                    playlistTableBody.innerHTML = '';
                    playlists.forEach((pl, index) => {
                        const row = document.createElement('tr');
                        // Type
                        const typeCell = document.createElement('td');
                        const typeInput = document.createElement('input');
                        typeInput.value = pl.type;
                        typeInput.addEventListener('input', () => {
                            pl.type = typeInput.value.trim();
                            configChanged();
                        });
                        typeCell.appendChild(typeInput);
                        // ID
                        const idCell = document.createElement('td');
                        const idInput = document.createElement('input');
                        idInput.value = pl.id;
                        idInput.required = true;
                        idInput.addEventListener('change', () => {
                            pl.id = idInput.value;
                            configChanged();
                        });
                        idCell.appendChild(idInput);
                        // Name
                        const nameCell = document.createElement('td');
                        const nameInput = document.createElement('input');
                        nameInput.value = pl.name;
                        nameInput.required = true;
                        nameInput.addEventListener('input', () => {
                            pl.name = nameInput.value.trim();
                            configChanged();
                        });
                        nameCell.appendChild(nameInput);
                        // Search Type
                        const channelTypeCell = document.createElement('td');
                        const channelTypeInput = document.createElement('select');
                        ${JSON.stringify(channelTypeArray)}.forEach((type, index) => {
                            const option = document.createElement('option');
                            option.value = index;
                            option.textContent = type.charAt(0).toUpperCase() + type.slice(1);
                            channelTypeInput.appendChild(option);
                        });
                        channelTypeInput.defaultValue = 0;
                        channelTypeInput.addEventListener('change', () => {
                            pl.channelType = channelTypeInput.value;
                            configChanged();
                        });
                        channelTypeCell.appendChild(channelTypeInput);
                        // Sort Order
                        pl.sortOrder = pl.sortOrder ?? [];
                        const sortOrderCell = document.createElement('td');
                        const sortOrderInput = document.createElement('button');
                        sortOrderInput.textContent = 'Modify';
                        sortOrderInput.title = 'Requires Playlist ID / URL to contain \\'${sortKeyword}\\'';
                        sortOrderInput.classList.add('install-button');
                        sortOrderInput.type = 'button';
                        sortOrderInput.addEventListener('click', () => {
                            if (!idInput.value?.includes(${JSON.stringify(sortKeyword)})) return;
                            const sorts = JSON.parse(JSON.stringify(pl.sortOrder));
                            function renderSorts() {
                                tbody.innerHTML = '';
                                sorts.forEach((s, index) => {
                                    const row = document.createElement('tr');
                                    const idCell = document.createElement('td');
                                    const idInput = document.createElement('input');
                                    idInput.required = true;
                                    idInput.addEventListener('change', () => s.id = idInput.value);
                                    idInput.value = s.id;
                                    const nameCell = document.createElement('td');
                                    const nameInput = document.createElement('input');
                                    nameInput.required = true;
                                    nameInput.addEventListener('change', () => s.name = nameInput.value);
                                    nameInput.value = s.name;
                                    idCell.appendChild(idInput);
                                    row.appendChild(idCell);
                                    nameCell.appendChild(nameInput);
                                    row.appendChild(nameCell);
                                    row.appendChild(makeActions(renderSorts, sorts, index));
                                    tbody.appendChild(row);
                                });
                            }
                            const blur = document.createElement('div');
                            blur.style.position = 'fixed';
                            blur.style.top = 0;
                            blur.style.left = 0;
                            blur.style.right = 0;
                            blur.style.bottom = 0;
                            blur.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
                            blur.addEventListener('click', e => {
                                e.preventDefault();
                                e.stopPropagation();
                            });
                            const modal = document.createElement('form');
                            modal.style.position = 'fixed';
                            modal.style.top = '50%';
                            modal.style.left = '50%';
                            modal.style.transform = 'translate(-50%, -50%)';
                            modal.classList.add('settings-section');
                            function closeModal(save = false) {
                                if (save) pl.sortOrder = sorts;
                                document.body.removeChild(blur);
                                document.body.removeChild(modal);
                            }
                            const title = document.createElement('h3');
                            title.textContent = 'Modify Sort Order';
                            const sortButtons = document.createElement('div');
                            sortButtons.style.marginBottom = '1rem';
                            const addSort = document.createElement('button');
                            addSort.type = 'button';
                            addSort.textContent = 'Add Sort';
                            addSort.classList.add('install-button');
                            addSort.addEventListener('click', () => {
                                sorts.push({ id: '', name: '' });
                                renderSorts();
                            });
                            const saveBtn = document.createElement('button');
                            saveBtn.type = 'submit';
                            saveBtn.textContent = 'Save';
                            saveBtn.classList.add('install-button');
                            modal.addEventListener('submit', () => {
                                closeModal(true);
                                configChanged();
                            });
                            const cancelBtn = document.createElement('button');
                            cancelBtn.textContent = 'Cancel';
                            cancelBtn.classList.add('install-button');
                            cancelBtn.addEventListener('click', () => closeModal(false));
                            const table = document.createElement('table');
                            table.style.width = '100%';
                            table.style.borderCollapse = 'collapse';
                            const thead = document.createElement('thead');
                            const headerRow = document.createElement('tr');
                            const thID = document.createElement('th');
                            thID.textContent = 'Sort ID';
                            const thName = document.createElement('th');
                            thName.textContent = 'Sort Name';
                            const thActions = document.createElement('th');
                            thActions.textContent = 'Actions';
                            const tbody = document.createElement('tbody');
                            renderSorts();
                            document.body.appendChild(blur);
                            headerRow.appendChild(thID);
                            headerRow.appendChild(thName);
                            headerRow.appendChild(thActions);
                            modal.appendChild(title);
                            modal.appendChild(document.createElement('hr'));
                            sortButtons.appendChild(addSort);
                            sortButtons.appendChild(saveBtn);
                            sortButtons.appendChild(cancelBtn);
                            modal.appendChild(sortButtons);
                            thead.appendChild(headerRow);
                            table.appendChild(thead);
                            table.appendChild(tbody);
                            modal.appendChild(table);
                            document.body.appendChild(modal);
                        });
                        sortOrderCell.appendChild(sortOrderInput);
                        row.appendChild(typeCell);
                        row.appendChild(idCell);
                        row.appendChild(nameCell);
                        row.appendChild(channelTypeCell);
                        row.appendChild(sortOrderCell);
                        row.appendChild(makeActions(renderPlaylists, playlists, index));
                        playlistTableBody.appendChild(row);
                    });
                    configChanged();
                }
                document.getElementById('add-playlist').addEventListener('click', () => {
                    playlists.push({ type: ${catalogType}, id: '', name: '', channelType: 'auto' });
                    renderPlaylists();
                });
                addDefaults.addEventListener('click', () => {
                    playlists = [...playlists, ...defaultPlaylists];
                    renderPlaylists();
                });
                document.getElementById('remove-defaults').addEventListener('click', () => {
                    playlists = playlists.filter(pl => !defaultPlaylists.some(def => def.id === pl.id));
                    renderPlaylists();
                });
                renderPlaylists();
                document.getElementById('config-form').addEventListener('submit', async function(event) {
                    event.preventDefault();
                    submitBtn.disabled = true;
                    const originalText = submitBtn.textContent
                    submitBtn.textContent = 'Encrypting...';
                    errorDiv.style.display = 'none';
                    try {
                        // Encrypt the sensitive data
                        if (cookies.value && !cookies.disabled)
                            cookies.value = await (await fetch('/encrypt', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({ 
                                    auth: cookies.value
                                })
                            })).text();
                        cookies.disabled = true;
                        const modifiedPlaylists = playlists.map(pl => ({
                            ...pl,
                            id: ${JSON.stringify(prefix)} + pl.id,
                            ...(pl.sortOrder?.length ? { sortOrder: pl.sortOrder } : {})
                        }));
                        const configString = \`://${req.get('host')}/\${encodeURIComponent(JSON.stringify({
                            ...(cookies.value ? {encrypted: cookies.value} : {}),
                            ...(modifiedPlaylists.length ? { catalogs: modifiedPlaylists } : {}),
                            // Non-Sensitive Settings
                            ...Object.fromEntries(
                                Array.from(addonSettings.querySelectorAll("input, select"))
                                    .map(x => {
                                        if (x.type === 'select-multiple') {
                                            const value = Array.from(x.selectedOptions).map(o => o.value);
                                            return value.length ? [x.name, value] : null;
                                        }
                                        const value = x.type === 'checkbox' ? (x.checked ? 1 : 0) : x.value;
                                        return value != x.dataset.default ? [x.name, value] : null;
                                    }).filter(x => x !== null)
                            )
                        }))}/\`;
                        const protocol = ${JSON.stringify(req.protocol)};
                        const manifestString = configString + 'manifest.json';
                        installStremio.href = 'stremio' + manifestString;
                        reload.href = \`\${protocol}\${configString}configure\`;
                        installUrlInput.value = protocol + manifestString;
                        installWeb.href = \`https://web.stremio.com/#/addons?addon=\${encodeURIComponent(installUrlInput.value)}\`;
                        resultsDiv.style.display = 'block';
                    } catch (error) {
                        errorDiv.textContent = error.message;
                        errorDiv.style.display = 'block';
                    } finally {
                        submitBtn.disabled = false;
                        submitBtn.textContent = originalText;
                    }
                });
                document.getElementById('copy-btn').addEventListener('click', async function() {
                    await navigator.clipboard.writeText(installUrlInput.value);
                    this.textContent = 'Copied!';
                    setTimeout(() => { this.textContent = 'Copy URL'; }, 2000);
                });
            </script>
        </body>
        </html>
    `);
});

// Error Handling Middleware
app.use((err, req, res, next) => {
    logError(err)
    if (!res.headersSent)
        res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start the Server
app.listen(PORT, () => {
    console.log(`Addon server v${VERSION} running on port ${PORT}`);
    if (!process.env.ENCRYPTION_KEY) {
        console.warn('WARNING: Using random encryption key. Set ENCRYPTION_KEY environment variable for production.');
        if (process.env.DEV_LOGGING) console.warn('Generated key (base64):', ENCRYPTION_KEY.toString('base64'));
    }
    console.log(`Access the configuration page at: ${process.env.SPACE_HOST ? 'https://' + process.env.SPACE_HOST : 'http://localhost:' + PORT}`);
});
