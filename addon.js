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
const postfix = ':1:1';
const reversedPrefix = 'Reversed';
const channelRegex = /^@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9]$/;
const playlistRegex = /^PL([0-9A-F]{16}|[A-Za-z0-9_-]{32})$/;
const videoRegex = /^[A-Za-z0-9_-]{10}[AEIMQUYcgkosw048]$/;

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
 * @returns {Object}
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
    next();
});

// Config Encryption Endpoint
app.post('/encrypt', (req, res) => {
    try {
        res.send(encrypt(JSON.stringify(req.body)));
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Encryption error:', error);
        res.status(500).send('Encryption failed');
    }
});

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
            if (process.env.DEV_LOGGING) console.error('Decryption error:', error);
            config.encrypted = undefined;
        }
    }
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
app.get('/:config/manifest.json', (req, res) => {
    try {
        const userConfig = decryptConfig(req.params.config, false);
        const canGenre = /** @param {Object} c */ (c) => {
            if (c.channelType !== 'auto') return true;
            const id = c.id?.startsWith(prefix) ? c.id.slice(prefix.length) : c.id ?? '';
            if ([':ytfav', ':ytwatchlater', ':ytsubs', ':ythistory', ':ytrec', ':ytnotif'].includes(id)) return false;
            if (id.match(channelRegex)) return false;
            if (id.match(playlistRegex)) return false;
            if (id.match(videoRegex)) return false;
            if ([':ytsearch', ':ytsearch:channel'].includes(id)) return true;
            return !isURL(id);
        }
        return res.json({
            id: 'youtubio.elfhosted.com',
            version: VERSION,
            name: 'YouTubio | ElfHosted',
            description: 'Watch YouTube videos, subscriptions, watch later, and history in Stremio.',
            resources: ['catalog', 'stream', 'meta'],
            types: ['movie', 'channel'],
            idPrefixes: [prefix],
            catalogs: [
                ...(userConfig.catalogs?.map(c => ({
                    ...c, extra: [
                        ...(c.extra ?? []),
                        ...(c.channelType === 'auto' &&
                            (c.id.includes('{term}') || [':ytsearch', ':ytsearch:channel'].includes(c.id.startsWith(prefix) ? c.id.slice(prefix.length) : c.id)) ?
                            [{ name: 'search', isRequired: true }] : [])
                    ]
                })) ?? [
                        { id: ':ytrec', name: 'Discover' },
                        { id: ':ytsubs', name: 'Subscriptions' },
                        { id: ':ytwatchlater', name: 'Watch Later' },
                        { id: ':ythistory', name: 'History' }
                        // Add search unless explicitly disabled
                    ]), ...(userConfig.search === false ? [] : [
                        { id: ':ytsearch', name: 'Video' },
                        { id: ':ytsearch:channel', name: 'Channel' }
                    ]).map(c => ({
                        ...c, extra: [
                            ...(c.extra ?? []),
                            { name: 'search', isRequired: true },
                        ]
                    }))
            ].map(c => ({
                ...c,
                id: c.id?.startsWith(prefix) ? c.id : prefix + (c.id ?? ''),
                type: c.type ?? 'YouTube',
                extra: [
                    ...(
                        c.extra ?? []
                    ), {
                        name: 'genre',
                        isRequired: false,
                        options: [
                            '',
                            // Add YouTube sorting options
                            ...(canGenre(c) ? ['Relevance', 'Upload Date', 'View Count', 'Rating'] : [])
                        ].flatMap(x => [x, `${reversedPrefix} ${x}`.trim()])  // Create reversed of each option
                            .slice(1)  // Remove default sorting option
                    }, {
                        name: 'skip',
                        isRequired: false
                    }
                ]
            })),
            logo: 'https://github.com/xXCrash2BomberXx/YouTubio/blob/main/YouTubio.png?raw=true',
            behaviorHints: {
                configurable: true
            },
            stremioAddonsConfig: {
                issuer: "https://stremio-addons.net",
                signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..tLliZZqbqp8DSpNFCa_o7g.1Zu-sGRA8Xmc-qG9d_ctvcvrbtBFdVH8Kqmj9RL-ONB5C5iiy5qITOH3Z1nrTfQuiIhwJyQuU0npD0S8lYtv5InjpulZHYQDdBJpPnTvn1jqwM4AgDPCpm05lNLYW3Kp.IpryYoO1JqXwFBmkHrD3OA"
            }
        });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Manifest handler: ' + error);
        return res.json({});
    }
});

/**
 * Converts a YouTube video ID and query parameters into a YouTube URL.
 * @param {Object} userConfig 
 * @param {string} videoId 
 * @param {Object} query 
 * @param {boolean=false} includeLive 
 * @returns {string}
 */
function toYouTubeURL(userConfig, videoId, query, includeLive = false) {
    /** @type {RegExpMatchArray?} */
    let temp;
    const catalogConfig = /** @type {Object[]} */ (userConfig.catalogs ?? []).find(cat => [videoId, prefix + videoId].includes(cat.id));
    /** @type {string?} */
    const videoId2 = (query.search ?? videoId).trim();
    /** @type {string} */
    const genre = (query.genre?.startsWith(reversedPrefix) ? query.genre.slice(reversedPrefix.length) : query.genre)?.trim() ?? 'Relevance';
    if (catalogConfig?.channelType === 'video' || videoId === ':ytsearch')
        return `https://www.youtube.com/results?search_query=${encodeURIComponent(videoId2)}&sp=${{
            'Relevance': 'CAASAhAB',
            'Upload Date': 'CAISAhAB',
            'View Count': 'CAMSAhAB',
            'Rating': 'CAESAhAB'
        }[genre]}`;
    else if (catalogConfig?.channelType === 'channel' || videoId === ':ytsearch:channel')
        return `https://www.youtube.com/results?search_query=${encodeURIComponent(videoId2)}&sp=${{
            'Relevance': 'CAASAhAC',
            'Upload Date': 'CAISAhAC',
            'View Count': 'CAMSAhAC',
            'Rating': 'CAESAhAC'
        }[genre]}`;
    else if ([':ytfav', ':ytwatchlater', ':ytsubs', ':ythistory', ':ytrec', ':ytnotif'].includes(videoId2))
        return videoId2;
    else if ((temp = videoId2.match(channelRegex)))
        return `https://www.youtube.com/${temp[0]}/${includeLive ? 'live' : 'videos'}`;
    else if ((temp = videoId2.match(playlistRegex)))
        return `https://www.youtube.com/playlist?list=${temp[0]}`;
    else if ((temp = videoId2.match(videoRegex)))
        return `https://www.youtube.com/watch?v=${temp[0]}`;
    else if (catalogConfig?.id.includes('{term}'))
        return (catalogConfig.id.startsWith(prefix) ? catalogConfig.id.slice(prefix.length) : catalogConfig.id).replaceAll('{term}', encodeURIComponent(query.search ?? ''));
    else if (isURL(videoId2))
        return videoId2;
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(videoId2)}&sp=${{
        'Relevance': 'CAASAhAB',
        'Upload Date': 'CAISAhAB',
        'View Count': 'CAMSAhAB',
        'Rating': 'CAESAhAB'
    }[genre]}`;
}

// Stremio Addon Catalog Route
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
        if (!req.params.id?.startsWith(prefix)) throw new Error(`Unknown ID in Catalog handler: "${req.params.id}"`);
        const userConfig = decryptConfig(req.params.config, false);
        const query = Object.fromEntries(new URLSearchParams(req.params.extra ?? ''));
        const skip = parseInt(query.skip ?? 0);
        const videos = await runYtDlpWithAuth(req.params.config, [
            '-I', query.genre?.startsWith(reversedPrefix) ? `${-(skip + 1)}:${-(skip + 100)}:-1` : `${skip + 1}:${skip + 100}:1`,
            '--yes-playlist',
            toYouTubeURL(userConfig, req.params.id?.slice(prefix.length).trim(), query)
        ]);
        const channel = videos.extractor_key === 'YoutubeTab';
        return res.json({
            metas: ((channel ? undefined : videos.entries) ?? [videos]).map(video => (
                (channel ? video.uploader_id : (video.id ?? video.url)) ? {
                    id: videos.webpage_url_domain == 'youtube.com' ? prefix + (channel ? video.uploader_id : (video.id ?? video.url)) : videos.entries ? prefix + video.url : req.params.id,
                    type: channel ? 'channel' : 'movie',
                    name: video.title ?? 'Unknown Title',
                    poster: video.thumbnail ?? video.thumbnails?.at(-1)?.url,
                    posterShape: channel ? 'square' : 'landscape',
                    description: video.description ?? video.title,
                    releaseInfo: parseInt(video.release_year ?? video.upload_date?.substring(0, 4))
                } : null
            )).filter(meta => meta !== null),
            behaviorHints: { cacheMaxAge: 0 }
        });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Catalog handler: ' + error);
        return res.json({ metas: [] });
    }
});

// Stremio Addon Meta Route
app.get('/:config/meta/:type/:id.json', async (req, res) => {
    try {
        if (!req.params.id?.startsWith(prefix)) throw new Error(`Unknown ID in Meta handler: "${req.params.id}"`);
        const userConfig = decryptConfig(req.params.config, false);
        /** @type {string?} */
        const videoId = req.params.id?.slice(prefix.length).trim();
        const video = await runYtDlpWithAuth(req.params.config, [
            userConfig.markWatchedOnLoad ? '--mark-watched' : '--no-mark-watched',
            '-I', ':1',  // Only fetch the first video since this never needs more than one
            '--no-playlist',
            toYouTubeURL(userConfig, videoId, Object.fromEntries(new URLSearchParams(req.params.extra ?? '')), true)
        ]);
        const channel = video._type === 'playlist';
        /** @type {string} */
        const title = video.title ?? 'Unknown Title';
        /** @type {string?} */
        const thumbnail = video.thumbnail ?? video.thumbnails?.at(-1).url;
        /** @type {string} */
        const released = new Date(video.release_timestamp ? video.release_timestamp * 1000 : video.upload_date ? `${video.upload_date.substring(0, 4)}-${video.upload_date.substring(4, 6)}-${video.upload_date.substring(6, 8)}T00:00:00Z` : 0).toISOString();
        const subtitles = Object.entries(video.subtitles ?? {}).map(([k, v]) => {
            const srt = v.find?.(x => x.ext == 'srt') ?? v[0];
            return srt ? {
                id: srt.name,
                url: srt.url,
                lang: k
            } : null;
        }).concat(
            Object.entries(video.automatic_captions ?? {}).map(([k, v]) => {
                const srt = v.find?.(x => x.ext == 'srt') ?? v[0];
                return srt ? {
                    id: `Auto ${srt.name}`,
                    url: srt.url,
                    lang: k
                } : null;
            })
        ).filter(srt => srt !== null);
        /** @type {boolean} */
        const isLive = video.is_live ?? false;
        const manifestUrl = encodeURIComponent(`${req.protocol}://${req.get('host')}/${encodeURIComponent(req.params.config)}/manifest.json`);
        /** @type {string?} */
        const ref = req.get('Referrer');
        const protocol = ref ? ref + '#' : 'stremio://';
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
                released: released,
                videos: [{
                    id: req.params.id + postfix,
                    title: title,
                    released: released,
                    thumbnail: thumbnail,
                    streams: [
                        ...(video.formats ?? [video]).filter(src => userConfig.showBrokenLinks || (!src.format_id?.startsWith('sb') && src.acodec !== 'none' && src.vcodec !== 'none')).filter(src => src.url).toReversed().map(src => ({
                            name: `YT-DLP Player ${src.resolution}`,
                            url: src.url,
                            description: src.format,
                            subtitles: subtitles,
                            behaviorHints: {
                                ...(src.protocol !== 'https' || src.video_ext !== 'mp4' ? { notWebReady: true } : {}),
                                videoSize: src.filesize_approx,
                                filename: video.filename
                            }
                        })), ...(isLive || !channel ? [
                            {
                                name: 'Stremio Player',
                                ytId: video.id,
                                description: 'Click to watch using Stremio\'s built-in YouTube Player'
                            }, {
                                name: 'External Player',
                                externalUrl: video.webpage_url,
                                description: 'Click to watch in the External Player'
                            }
                        ] : []), ...(video.uploader_id ? [{
                            name: 'YT-DLP Channel',
                            externalUrl: `${protocol}/discover/${manifestUrl}/movie/${encodeURIComponent(prefix + video.uploader_id)}`,
                            description: 'Click to open the channel as a Catalog'
                        }] : []), ...(video.uploader_url ? [{
                            name: 'External Channel',
                            externalUrl: video.uploader_url,
                            description: 'Click to open the channel in the External Player'
                        }] : [])
                    ],
                    episode: 1,
                    season: 1,
                    overview: video.description ?? title
                }],
                runtime: `${Math.floor((video.duration ?? 0) / 60)} min`,
                language: video.language,
                website: video.webpage_url,
                behaviorHints: { defaultVideoId: req.params.id + postfix }
            }
        });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Meta handler: ' + error);
        return res.json({ meta: {} });
    }
});

// Stremio Addon Stream Route
app.get('/:config/stream/:type/:id.json', async (req, res) => {
    return res.json({ streams: [] });
});

// Configuration Page
app.get(['/', '/:config?/configure'], async (req, res) => {
    /** @type {Object?} */
    let userConfig;
    try {
        userConfig = req.params.config ? decryptConfig(req.params.config, false) : {};
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Config handler: ' + error);
        userConfig = {};
    }
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
                #playlist-table th, #playlist-table td { border: 0.1rem solid #ccc; padding: 1rem; text-align: left; }
                #playlist-table input { width: 100%; box-sizing: border-box; }
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
                    textarea, #playlist-table input, select { 
                        background: #2a2a2a; 
                        color: #e0e0e0; 
                        border: 0.1rem solid #555; 
                    }
                    #playlist-table th, #playlist-table td { border: 0.1rem solid #555; }
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
                <h1>YouTubio | ElfHosted</h1>
                <h3 style="color: #f5a623;">v${VERSION}</h3>
                ${process.env.EMBED ?? ""}
                For a quick setup guide, go to <a href="https://github.com/xXCrash2BomberXx/YouTubio#%EF%B8%8F-quick-setup-with-cookies" target="_blank" rel="noopener noreferrer">github.com/xXCrash2BomberXx/YouTubio</a>
                <form id="config-form">
                    <div class="settings-section">
                        <details style="text-align: center;">
                            <summary>
                                This addon supports FAR more than just YouTube with links!<br>
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
                        <textarea id="cookie-data" placeholder="Paste the content of your cookies.txt file here..."></textarea>
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
                                You can use <b><code>{term}</code></b> in the <b>Playlist ID / URL</b> for custom search catalogs in places the encoded URI search component is used.
                                ex. <code>https://www.youtube.com/results?search_query=example+search</code> &rarr; <code>https://www.youtube.com/results?search_query={term}</code>
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
                                    <th>Name</th>
                                    <th>Search Type</th>
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
                                <tr>
                                    <td><input type="checkbox" id="markWatchedOnLoad" name="markWatchedOnLoad"></td>
                                    <td><label for="markWatchedOnLoad">Mark watched on load</label></td>
                                    <td class="setting-description">When enabled, videos will be automatically marked as watched in your YouTube history when you open them in Stremio. This helps keep your YouTube watch history synchronized.</td>
                                </tr>
                                <tr>
                                    <td><input type="checkbox" id="search" name="search" checked></td>
                                    <td><label for="search">Allow searching</label></td>
                                    <td class="setting-description">When enabled, Stremio's search feature will also return YouTube results.</td>
                                </tr>
                                <tr>
                                    <td><input type="checkbox" id="showBrokenLinks" name="showBrokenLinks"></td>
                                    <td><label for="showBrokenLinks">Show Broken Links</label></td>
                                    <td class="setting-description">When enabled, all resolutions found by YT-DLP will be returned, not just ones supported by Stremio. This may fix some issues if you encounter crashes on videos without it enabled.</td>
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
                    <input type="text" id="install-url" style="display: none;" readonly class="url-input">
                </div>
            </div>
            <script>
                const cookies = document.getElementById('cookie-data');
                const addonSettings = document.getElementById('addon-settings');
                const submitBtn = document.getElementById('submit-btn');
                const errorDiv = document.getElementById('error-message');
                const resultsDiv = document.getElementById('results');
                function configChanged() {
                    resultsDiv.style.display = 'none';
                }
                const installStremio = document.getElementById('install-stremio');
                const installUrlInput = document.getElementById('install-url');
                const installWeb = document.getElementById('install-web');
                const playlistTableBody = document.querySelector('#playlist-table tbody');
                const defaultPlaylists = [
                    { type: 'YouTube', id: ':ytrec', name: 'Discover', channelType: 'auto' },
                    { type: 'YouTube', id: ':ytsubs', name: 'Subscriptions', channelType: 'auto' },
                    { type: 'YouTube', id: ':ytwatchlater', name: 'Watch Later', channelType: 'auto' },
                    { type: 'YouTube', id: ':ythistory', name: 'History', channelType: 'auto' }
                ];
                let playlists = ${userConfig.catalogs ? JSON.stringify(userConfig.catalogs.map(pl => ({
        ...pl,
        id: pl.id.startsWith(prefix) ? pl.id.slice(prefix.length) : pl.id
    }))) : 'JSON.parse(JSON.stringify(defaultPlaylists))'};
                ${userConfig.encrypted ? `cookies.value = ${JSON.stringify(userConfig.encrypted)}; cookies.disabled = true;` : ''}
                document.getElementById('markWatchedOnLoad').checked = ${userConfig.markWatchedOnLoad === true ? 'true' : 'false'};
                document.getElementById('search').checked = ${userConfig.search === false ? 'false' : 'true'};
                document.getElementById('showBrokenLinks').checked = ${userConfig.showBrokenLinks === true ? 'true' : 'false'};
                document.getElementById('clear-cookies').addEventListener('click', () => {
                    cookies.value = "";
                    cookies.disabled = false;
                    configChanged();
                });
                cookies.addEventListener('input', configChanged);
                addonSettings.querySelectorAll("input, select").forEach(e => e.addEventListener('change', configChanged));
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
                        idInput.addEventListener('change', () => {
                            pl.id = idInput.value;
                            configChanged();
                        });
                        idCell.appendChild(idInput);
                        // Name
                        const nameCell = document.createElement('td');
                        const nameInput = document.createElement('input');
                        nameInput.value = pl.name;
                        nameInput.addEventListener('input', () => {
                            pl.name = nameInput.value.trim();
                            configChanged();
                        });
                        nameCell.appendChild(nameInput);
                        // Channel Search
                        const channelTypeCell = document.createElement('td');
                        const channelTypeInput = document.createElement('select');
                        const optAuto = document.createElement('option');
                        optAuto.value = 'auto';
                        optAuto.textContent = 'Auto';
                        channelTypeInput.appendChild(optAuto);
                        const optVideo = document.createElement('option');
                        optVideo.value = 'video';
                        optVideo.textContent = 'Video';
                        channelTypeInput.appendChild(optVideo);
                        const optChannel = document.createElement('option');
                        optChannel.value = 'channel';
                        optChannel.textContent = 'Channel';
                        channelTypeInput.appendChild(optChannel);
                        channelTypeInput.value = pl.channelType;
                        channelTypeInput.addEventListener('change', () => {
                            pl.channelType = channelTypeInput.value;
                            configChanged();
                        });
                        channelTypeCell.appendChild(channelTypeInput);
                        // Actions
                        const actionsCell = document.createElement('td');
                        const upBtn = document.createElement('button');
                        upBtn.textContent = '↑';
                        upBtn.classList.add('install-button');
                        upBtn.style.margin = '0.2rem';
                        upBtn.addEventListener('click', () => {
                            if (index > 0) {
                                [playlists[index - 1], playlists[index]] = [playlists[index], playlists[index - 1]];
                                renderPlaylists();
                            }
                        });
                        const downBtn = document.createElement('button');
                        downBtn.textContent = '↓';
                        downBtn.classList.add('install-button');
                        downBtn.style.margin = '0.2rem';
                        downBtn.addEventListener('click', () => {
                            if (index < playlists.length - 1) {
                                [playlists[index + 1], playlists[index]] = [playlists[index], playlists[index + 1]];
                                renderPlaylists();
                            }
                        });
                        const removeBtn = document.createElement('button');
                        removeBtn.textContent = 'Remove';
                        removeBtn.classList.add('install-button');
                        removeBtn.style.margin = '0.2rem';
                        removeBtn.addEventListener('click', () => {
                            playlists.splice(index, 1);
                            renderPlaylists();
                        });
                        actionsCell.appendChild(upBtn);
                        actionsCell.appendChild(downBtn);
                        actionsCell.appendChild(removeBtn);
                        row.appendChild(typeCell);
                        row.appendChild(idCell);
                        row.appendChild(nameCell);
                        row.appendChild(channelTypeCell);
                        row.appendChild(actionsCell);
                        playlistTableBody.appendChild(row);
                    });
                    configChanged();
                }
                document.getElementById('add-playlist').addEventListener('click', () => {
                    playlists.push({ type: 'YouTube', id: '', name: '', channelType: 'auto' });
                    renderPlaylists();
                });
                document.getElementById('add-defaults').addEventListener('click', () => {
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
                    submitBtn.textContent = 'Encrypting...';
                    errorDiv.style.display = 'none';
                    try {
                        if (!cookies.disabled) {
                            // Encrypt the sensitive data
                            const encryptResponse = await fetch('/encrypt', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({ 
                                    auth: cookies.value,
                                })
                            });
                            if (!encryptResponse.ok) {
                                throw new Error(await encryptResponse.text() || 'Encryption failed');
                            }
                            cookies.value = await encryptResponse.text();
                            cookies.disabled = true;
                        }
                        const configString = \`://${req.get('host')}/\${encodeURIComponent(JSON.stringify({
                            encrypted: cookies.value,
                            catalogs: playlists.map(pl => ({ ...pl, id: ${JSON.stringify(prefix)} + pl.id })),
                            ...Object.fromEntries(
                                Array.from(addonSettings.querySelectorAll("input, select"))
                                    .map(x => [x.name, x.type === 'checkbox' ? x.checked : x.value])
                            )
                        }))}/manifest.json\`;
                        installStremio.href = 'stremio' + configString;
                        installUrlInput.value = ${JSON.stringify(req.protocol)} + configString;
                        installWeb.href = \`https://web.stremio.com/#/addons?addon=\${encodeURIComponent(installUrlInput.value)}\`;
                        resultsDiv.style.display = 'block';
                    } catch (error) {
                        errorDiv.textContent = error.message;
                        errorDiv.style.display = 'block';
                    } finally {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Generate Install Link';
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
    if (process.env.DEV_LOGGING) console.error('Express error:', err);
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
