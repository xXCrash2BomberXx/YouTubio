#!/usr/bin/env node

const express = require('express');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
// const util = require('util');

const tmpdir = require('os').tmpdir();
const ytDlpWrap = new YTDlpWrap();
const PORT = process.env.PORT || 7000;
const prefix = 'yt_id:';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ? Buffer.from(process.env.ENCRYPTION_KEY, 'base64') : crypto.randomBytes(32);
const ALGORITHM = 'aes-256-gcm';

const extractors = ytDlpWrap.getExtractors();
const supportedWebsites = new Promise(async resolve => {
    return resolve(`<ul style="list-style-type: none;">${(await extractors).map(extractor => '<li>'+extractor+'</li>').join('')}</ul>`);
});

function encrypt(text) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
        ALGORITHM,
        crypto.createHash('sha256').update(Buffer.concat([ENCRYPTION_KEY, salt])).digest(),
        iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return salt.toString('hex') + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

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
async function runYtDlpWithAuth(encryptedConfig, argsArray) {
    try {
        const auth = decryptConfig(encryptedConfig).encrypted?.auth;
        // Implement better auth system
        const cookies = auth;
        const filename = cookies ? path.join(tmpdir, `cookies-${Date.now()}-${counter++}.txt`) : '';
        counter %= Number.MAX_SAFE_INTEGER;
        if (filename) await fs.writeFile(filename, cookies);
        return JSON.parse(await ytDlpWrap.execPromise([
            ...argsArray,
            '-i',
            '-q',
            '--no-warnings',
            '-s',
            '--no-cache-dir',
            '--flat-playlist',
            '-J',
            '--ies', process.env.YTDLP_EXTRACTORS ?? 'all',
            '--default-search', 'ytsearch100',
            '--extractor-args', 'generic:impersonate',
            ...(cookies ? ['--cookies', filename] : [])
        ]));
    } finally {
        try {
            if (filename) await fs.unlink(filename);
        } catch (error) {}
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
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
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
function decryptConfig(configParam, enableDecryption = true) {
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

// Stremio Addon Manifest Route
app.get('/:config/manifest.json', (req, res) => {
    try {
        const userConfig = decryptConfig(req.params.config, false);
        return res.json({
            id: 'youtubio.elfhosted.com',
            version: '0.4.4',
            name: 'YouTubio | ElfHosted',
            description: 'Watch YouTube videos, subscriptions, watch later, and history in Stremio.',
            resources: ['catalog', 'stream', 'meta'],
            types: ['movie', 'channel'],
            idPrefixes: [prefix],
            catalogs: (userConfig.catalogs?.map(c => ({
                ...c,
                extra: [ { name: 'skip', isRequired: false } ]
            })) ?? [
                { type: 'YouTube', id: `${prefix}:ytrec`, name: 'Discover', extra: [ { name: 'skip', isRequired: false } ] },
                { type: 'YouTube', id: `${prefix}:ytsubs`, name: 'Subscriptions', extra: [ { name: 'skip', isRequired: false } ] },
                { type: 'YouTube', id: `${prefix}:ytwatchlater`, name: 'Watch Later', extra: [ { name: 'skip', isRequired: false } ] },
                { type: 'YouTube', id: `${prefix}:ythistory`, name: 'History', extra: [ { name: 'skip', isRequired: false } ] }
            ]).concat([
                // Add search unless explicitly disabled
                ...(userConfig.search === false ? [] : [
                    { type: 'YouTube', id: `${prefix}:ytsearch100`, name: 'Mixed', extra: [ { name: 'search', isRequired: true }, { name: 'skip', isRequired: false } ] },
                    { type: 'YouTube', id: `${prefix}:ytsearch100:video`, name: 'Video', extra: [ { name: 'search', isRequired: true }, { name: 'skip', isRequired: false } ] },
                    { type: 'YouTube', id: `${prefix}:ytsearch100:channel`, name: 'Channel', extra: [ { name: 'search', isRequired: true }, { name: 'skip', isRequired: false } ] }
                ])
            ]),
            logo: 'https://github.com/xXCrash2BomberXx/YouTubio/blob/main/YouTubio.png?raw=true',
            behaviorHints: {
                configurable: true
            },
            "stremioAddonsConfig": {
                "issuer": "https://stremio-addons.net",
                "signature": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..tLliZZqbqp8DSpNFCa_o7g.1Zu-sGRA8Xmc-qG9d_ctvcvrbtBFdVH8Kqmj9RL-ONB5C5iiy5qITOH3Z1nrTfQuiIhwJyQuU0npD0S8lYtv5InjpulZHYQDdBJpPnTvn1jqwM4AgDPCpm05lNLYW3Kp.IpryYoO1JqXwFBmkHrD3OA"
            }
        });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Manifest handler: ' + error);
        return res.json({});
    }
});

// Stremio Addon Catalog Route
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
        if (!req.params.id?.startsWith(prefix)) throw new Error(`Unknown ID in Catalog handler: "${req.params.id}"`);
        const userConfig = decryptConfig(req.params.config, false);
        const catalogConfig = userConfig.catalogs.find(cat => cat.id === req.params.id);
        let videoId = req.params.id?.slice(prefix.length);
        const query = Object.fromEntries(new URLSearchParams(req.params.extra ?? ''));
        const skip = parseInt(query?.skip ?? 0);
        const videoIdCopy = videoId;
        switch (catalogConfig?.channelType) {
        case 'video':
            // Saved Video Search
            videoId = `https://www.youtube.com/results?sp=EgIQAQ%253D%253D&search_query=${encodeURIComponent(videoId)}`;
            break;
        case 'channel':
            // Saved Channel Search
            videoId = `https://www.youtube.com/results?sp=EgIQAg%253D%253D&search_query=${encodeURIComponent(videoId)}`;
            break;
        case 'auto':
        case undefined:
        default:
            switch (videoIdCopy) {
            // YT-DLP Playlists
            case ':ytfav':
            case ':ytwatchlater':
            case ':ytsubs':
            case ':ythistory':
            case ':ytrec':
            case ':ytnotif':
                break;
            default:
                // YT-DLP Search
                if (videoIdCopy.startsWith(':ytsearch100')) {
                    if (!query?.search) throw new Error("Missing query parameter");
                    switch(videoIdCopy.slice(':ytsearch100'.length)) {
                    // Video Search
                    case ':video':
                        videoId = `https://www.youtube.com/results?sp=EgIQAQ%253D%253D&search_query=${encodeURIComponent(query.search)}`;
                        break;
                    // Channel Search
                    case ':channel':
                        videoId = `https://www.youtube.com/results?sp=EgIQAg%253D%253D&search_query=${encodeURIComponent(query.search)}`;
                        break;
                    // Mixed Search
                    case '':
                    default:
                        videoId = query.search;
                        break;
                    // Channels
                    }
                } else if ( (videoId = videoIdCopy.match(/^@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9]$/)) ) {
                    videoId = `https://www.youtube.com/${videoId[0]}/videos`;
                // Playlists
                } else if ( (videoId = videoIdCopy.match(/^PL([0-9A-F]{16}|[A-Za-z0-9_-]{32})$/)) ) {
                    videoId = `https://www.youtube.com/playlist?list=${videoId[0]}`;
                // Saved YT-DLP Search
                } else {
                    videoId = videoIdCopy;
                }
                break;
            }
            break;
        }
        const videos = await runYtDlpWithAuth(req.params.config, [
            videoId,
            '-I', `${skip + 1}:${skip + 100}:1`,
        ]);
        return res.json({
            metas: (videos.entries ?? [ videos ]).map(video => {
                    const channel = video.ie_key === 'YoutubeTab';
                    return (channel ? video.uploader_id : (video.id ?? video.url)) ? {
                        id: prefix + (channel ? video.uploader_id : (video.id ?? video.url)),
                        type: channel ? 'channel' : 'movie',
                        name: video.title ?? 'Unknown Title',
                        poster: ((channel ? 'https:' : '') + (video.thumbnail ?? video.thumbnails?.at(-1)?.url ?? '')) ?? undefined,
                        posterShape: channel ? 'square' : 'landscape',
                        description: video.description ?? video.title,
                        releaseInfo: video.upload_date?.substring(0, 4)
                    } : null;
                }).filter(meta => meta !== null),
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
        const videoId = req.params.id?.slice(prefix.length);
        const ref = req.get('Referrer');
        const protocol = ref ? ref + '#' : 'stremio://';
        const manifestUrl = encodeURIComponent(`${req.protocol}://${req.get('host')}/${encodeURIComponent(req.params.config)}/manifest.json`);
        let command;
        if ( (command = videoId.match(/^@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9]$/)) ) {
            command = `https://www.youtube.com/${command[0]}/videos`;
        // Playlists
        } else if ( (command = videoId.match(/^PL([0-9A-F]{16}|[A-Za-z0-9_-]{32})$/)) ) {
            command = `https://www.youtube.com/watch?v=${command[0]}`;
        } else {
            command = videoId;
        }
        const video = await runYtDlpWithAuth(req.params.config, [
            command,
            '--playlist-end', '1',  // Only fetch the first video since this never needs more than one
            '--ignore-no-formats-error',
            ...(userConfig.markWatchedOnLoad ? ['--mark-watched'] : [])
        ]);
        const channel = video._type === 'playlist';
        const title = video.title ?? 'Unknown Title';
        const thumbnail = video.thumbnail ?? video.thumbnails?.at(-1).url;
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
        return res.json({ meta: {
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
                id: req.params.id + ':1:1',
                title: title,
                released: released,
                thumbnail: thumbnail,
                streams: [
                    ...(!channel ? [
                        ...(video.formats ?? [video]).filter(src => userConfig.showBrokenLinks || (!src.format_id.startsWith('sb') && src.acodec !== 'none' && src.vcodec !== 'none')).toReversed().map(src => ({
                            name: `YT-DLP Player ${src.resolution}`,
                            url: src.url,
                            description: src.format,
                            subtitles: subtitles,
                            behaviorHints: {
                                ...(src.protocol !== 'https' || src.video_ext !== 'mp4' ? { notWebReady: true } : {}),
                                videoSize: src.filesize_approx,
                                filename: video.filename
                            }
                        })), ...(videoId.match(/^[A-Za-z0-9_-]{10}[AEIMQUYcgkosw048]$/) ? [{
                            name: 'Stremio Player',
                            ytId: videoId,
                            description: 'Click to watch using Stremio\'s built-in YouTube Player'
                        }] : []), {
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
            behaviorHints: { defaultVideoId: req.params.id + ':1:1' }
        } });
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
    let userConfig;
    try {
        userConfig = decryptConfig(req.params.config, false);
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Config handler: ' + error);
        userConfig = {};
    }
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>YouTubio | ElfHosted</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; text-align: center; padding: 40px; background: #f4f4f8; color: #333; }
                .container { max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                h1 { color: #d92323; }
                p { font-size: 1.1em; line-height: 1.6; }
                textarea { width: 100%; height: 150px; padding: 10px; margin-top: 15px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box; resize: vertical; }
                #playlist-table th, #playlist-table td { border: 1px solid #ccc; padding: 5px; text-align: left; }
                #playlist-table input { width: 100%; box-sizing: border-box; }
                .install-button { display: inline-block; margin-top: 20px; padding: 15px 30px; background-color: #5835b0; color: white; text-decoration: none; font-size: 1.2em; border-radius: 5px; transition: background-color 0.3s; border: none; cursor: pointer; }
                .install-button:hover { background-color: #4a2c93; }
                .install-button:disabled { background-color: #ccc; cursor: not-allowed; }
                .action-button { padding: 5px 10px; font-size: 0.9em; }
                .url-input { width: 100%; padding: 10px; margin-top: 15px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box; }
                .instructions { text-align: left; margin-top: 25px; padding: 15px; border: 1px solid #ddd; border-radius: 5px; background: #f9f9f9; }
                .instructions summary { font-weight: bold; cursor: pointer; }
                .instructions ul { padding-left: 20px; }
                .instructions li { margin-bottom: 8px; }
                #results { margin-top: 20px; }
                .error { color: #d92323; margin-top: 10px; }
                .loading { color: #666; font-style: italic; }
                .settings-section { text-align: left; margin-top: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px; background: #f9f9f9; }
                .toggle-container { display: flex; align-items: center; margin: 10px 0; }
                .toggle-container input[type="checkbox"] { margin-right: 10px; }
                .toggle-container label { font-weight: normal; cursor: pointer; }
                .setting-description { font-size: 0.9em; color: #666; margin-top: 5px; line-height: 1.4; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>YouTubio | ElfHosted</h1>
                ${process.env.EMBED || ""}
                For a quick setup guide, go to <a href="https://github.com/xXCrash2BomberXx/YouTubio/tree/main?tab=readme-ov-file#quick-setup-with-cookies" target="_blank" rel="noopener noreferrer">github.com/xXCrash2BomberXx/YouTubio</a>
                <form id="config-form">
                    <div class="settings-section" style="text-align: center;">
                        <details>
                            <summary>
                                This addon supports FAR more than just YouTube with links!<br>
                                <a href="https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md" target="_blank" rel="noopener noreferrer">Read more here.</a>
                            </summary>
                            ${process.env.YTDLP_EXTRACTORS_EMBED}
                            <div style="max-height: 20em; overflow: auto;">
                                ${await supportedWebsites}
                            </div>
                        </details>
                    </div>
                    <div class="settings-section">
                        <h3>Cookies</h3>
                        <textarea id="cookie-data" placeholder="Paste the content of your cookies.txt file here..."></textarea>
                        <button type="button" class="install-button action-button" id="clear-cookies">Clear</button>
                    </div>
                    <div class="settings-section">
                        <h3>Playlists</h3>
                        <div style="margin-bottom: 10px;">
                            <button type="button" id="add-defaults" class="install-button action-button">Add Defaults</button>
                            <button type="button" id="remove-defaults" class="install-button action-button">Remove Defaults</button>
                            <button type="button" id="add-playlist" class="install-button action-button">Add Playlist</button>
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
                                    <td class="setting-description">When enabled, all resolutions found by YT-DLP will be returned, not just ones supported by Stremio. This may fix some issues if you encounter crashes on vidoes without it enabled.</td>
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
                });
                function renderPlaylists() {
                    playlistTableBody.innerHTML = '';
                    playlists.forEach((pl, index) => {
                        const row = document.createElement('tr');
                        // Type
                        const typeCell = document.createElement('td');
                        const typeInput = document.createElement('input');
                        typeInput.value = pl.type;
                        typeInput.addEventListener('input', () => pl.type = typeInput.value.trim());
                        typeCell.appendChild(typeInput);
                        // ID
                        const idCell = document.createElement('td');
                        const idInput = document.createElement('input');
                        idInput.value = pl.id;
                        idInput.addEventListener('change', () => pl.id = idInput.value);
                        idCell.appendChild(idInput);
                        // Name
                        const nameCell = document.createElement('td');
                        const nameInput = document.createElement('input');
                        nameInput.value = pl.name;
                        nameInput.addEventListener('input', () => pl.name = nameInput.value.trim());
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
                        channelTypeInput.addEventListener('change', () => pl.channelType = channelTypeInput.value);
                        channelTypeCell.appendChild(channelTypeInput);
                        // Actions
                        const actionsCell = document.createElement('td');
                        const upBtn = document.createElement('button');
                        upBtn.textContent = '↑';
                        upBtn.addEventListener('click', () => {
                            if (index > 0) {
                                [playlists[index - 1], playlists[index]] = [playlists[index], playlists[index - 1]];
                                renderPlaylists();
                            }
                        });
                        const downBtn = document.createElement('button');
                        downBtn.textContent = '↓';
                        downBtn.addEventListener('click', () => {
                            if (index < playlists.length - 1) {
                                [playlists[index + 1], playlists[index]] = [playlists[index], playlists[index + 1]];
                                renderPlaylists();
                            }
                        });
                        const removeBtn = document.createElement('button');
                        removeBtn.textContent = 'Remove';
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
                        document.getElementById('results').style.display = 'block';
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
    console.log(`Addon server running on port ${PORT}`);
    if (!process.env.ENCRYPTION_KEY) {
        console.warn('WARNING: Using random encryption key. Set ENCRYPTION_KEY environment variable for production.');
        if (process.env.DEV_LOGGING) console.warn('Generated key (base64):', ENCRYPTION_KEY.toString('base64'));
    }
    console.log(`Access the configuration page at: ${process.env.SPACE_HOST ? 'https://' + process.env.SPACE_HOST : 'http://localhost:' + PORT}`);
});
