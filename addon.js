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
    const auth = decryptConfig(encryptedConfig).encrypted?.auth;
    // Implement better auth system
    const cookies = auth;
    const filename = cookies ? path.join(tmpdir, `cookies-${Date.now()}-${counter++}.txt`) : '';
    counter %= Number.MAX_SAFE_INTEGER;
    try {
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
            ...(cookies ? ['--cookies', filename] : [])
        ]));
    } finally {
        try {
            if (filename) await fs.unlink(filename);
        } catch (error) {}
    }
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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
        config.encrypted = JSON.parse(decrypt(config.encrypted));
    }
    return config;
}

// Stremio Addon Manifest Route
app.get('/:config/manifest.json', (req, res) => {
    try {
        const userConfig = decryptConfig(req.params.config, false);

        return res.json({
            id: 'youtubio.elfhosted.com',
            version: '0.1.5',
            name: 'YouTubio | ElfHosted',
            description: 'Watch YouTube videos, subscriptions, watch later, and history in Stremio.',
            resources: ['catalog', 'stream', 'meta'],
            types: ['mixed', 'movie', 'channel'],
            idPrefixes: [prefix],
            catalogs: (userConfig.catalogs?.map(c => {
                c.extra = [ { name: 'skip', isRequired: false } ];
                return c;
            }) ?? [
                { type: 'movie', id: `${prefix}:ytrec`, name: 'Discover', extra: [ { name: 'skip', isRequired: false } ] },
                { type: 'movie', id: `${prefix}:ytsubs`, name: 'Subscriptions', extra: [ { name: 'skip', isRequired: false } ] },
                { type: 'movie', id: `${prefix}:ytwatchlater`, name: 'Watch Later', extra: [ { name: 'skip', isRequired: false } ] },
                { type: 'movie', id: `${prefix}:ythistory`, name: 'History', extra: [ { name: 'skip', isRequired: false } ] }
            ]).concat([
                // Add search unless explicitly disabled
                ...(userConfig.search === false ? [] : [
                    { type: 'mixed', id: `${prefix}:ytsearch`, name: 'YouTube', extra: [ { name: 'search', isRequired: true }, { name: 'skip', isRequired: false } ] },
                    { type: 'movie', id: `${prefix}:ytsearch:video`, name: 'YouTube', extra: [ { name: 'search', isRequired: true }, { name: 'skip', isRequired: false } ] },
                    { type: 'channel', id: `${prefix}:ytsearch:channel`, name: 'YouTube', extra: [ { name: 'search', isRequired: true }, { name: 'skip', isRequired: false } ] }
                ])
            ]),
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
        const videoId = req.params.id?.slice(prefix.length);
        const query = Object.fromEntries(new URLSearchParams(req.params.extra ?? ''));
        const skip = parseInt(query?.skip ?? 0);

        let command;
        // YT-DLP Search
        if (videoId.startsWith(':ytsearch')) {
            if (!query?.search) throw new Error("Missing query parameter");
            const videoId2 = videoId.slice(':ytsearch'.length);
            // Video Search
            if ([':video'].includes(videoId2))
                command = `https://www.youtube.com/results?sp=EgIQAQ%253D%253D&search_query=${encodeURIComponent(query.search)}`;
            // Channel Search
            else if ([':channel'].includes(videoId2))
                command = `https://www.youtube.com/results?sp=EgIQAg%253D%253D&search_query=${encodeURIComponent(query.search)}`;
            // Mixed Search
            else
                command = `ytsearch100:${query.search}`;
        // YT-DLP Playlists
        } else if (videoId.startsWith(":") && [':ytfav', ':ytwatchlater', ':ytsubs', ':ythistory', ':ytrec', ':ytnotif'].includes(videoId)) {
            command = videoId;
        // Channels
        } else if ( (command = videoId.match(/@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9]/)) ) {
            command = `https://www.youtube.com/${command[0]}/videos`;
        // Playlists
        } else if ( (command = videoId.match(/PL([0-9A-F]{16}|[A-Za-z0-9_-]{32})/)) ) {
            command = `https://www.youtube.com/playlist?list=${command[0]}`;
        // Saved Channel Search
        } else if (req.params.type === 'channel') {
            command = `https://www.youtube.com/results?sp=EgIQAg%253D%253D&search_query=${encodeURIComponent(videoId)}`;
        // Saved YT-DLP Search
        } else {
            command = `ytsearch100:${videoId}`;
        }

        return res.json({ metas: 
            (await runYtDlpWithAuth(req.params.config, [
                command,
                '-I', `${skip + 1}:${skip + 100}:1`,
            ])).entries.map(video => {
                const channel = video.ie_key === 'YoutubeTab';
                return (channel ? video.uploader_id : video.id) ? {
                    id: prefix + (channel ? video.uploader_id : video.id),
                    type: channel ? 'channel' : 'movie',
                    name: video.title ?? 'Unknown Title',
                    poster: (channel ? 'https:' : '') + (video.thumbnail ?? video.thumbnails?.at(-1)?.url),
                    posterShape: channel ? 'square' : 'landscape',
                    description: video.description,
                    releaseInfo: video.upload_date?.substring(0, 4)
                } : null;
            }).filter(meta => meta !== null)
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
        const host = req.get('host');
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const manifestUrl = encodeURIComponent(`${protocol}://${host}/${req.params.config}/manifest.json`);
        const command = `https://www.youtube.com/${videoId.startsWith('@') ? '' : 'watch?v='}${videoId}`;
        const video = await runYtDlpWithAuth(req.params.config, [
            command,
            '--playlist-end', '1',  // Only fetch the first video since this never needs more than one
            '--ignore-no-formats-error',
            ...(userConfig.markWatchedOnLoad ? ['--mark-watched'] : [])
        ]);
        const channel = video._type === 'playlist';
        const title = video.title ?? 'Unknown Title';
        const thumbnail = video.thumbnail ?? video.thumbnails?.at(-1).url;
        const released = video.timestamp ? new Date(video.timestamp * 1000).toISOString() : undefined;
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
            description: video.description,
            releaseInfo: video.upload_date?.substring(0, 4),
            released: released,
            videos: [{
                id: req.params.id,
                title: title,
                released: released,
                thumbnail: thumbnail,
                streams: [
                    ...(!channel ? [
                        ...(video.formats ?? []).filter(src => userConfig.showBrokenLinks || (!src.format_id.startsWith('sb') && src.acodec !== 'none' && src.vcodec !== 'none')).toReversed().map(src => ({
                            name: `YT-DLP Player ${src.resolution}`,
                            url: src.url,
                            description: src.format,
                            subtitles: subtitles,
                            behaviorHints: {
                                ...(src.protocol !== 'https' || src.video_ext !== 'mp4' ? { notWebReady: true } : {}),
                                videoSize: src.filesize_approx,
                                filename: video.filename
                            }
                        })), {
                            name: 'Stremio Player',
                            ytId: videoId,
                            description: 'Click to watch using Stremio\'s built-in YouTube Player'
                        }, {
                            name: 'YouTube Player',
                            externalUrl: video.original_url,
                            description: 'Click to watch in the official YouTube Player'
                        }
                    ] : []), {
                        name: 'YT-DLP Channel',
                        externalUrl: `stremio:///discover/${manifestUrl}/movie/${encodeURIComponent(prefix + video.uploader_id)}`,
                        description: 'Click to open the channel as a Catalog'
                    }, {
                        name: 'YouTube Channel',
                        externalUrl: video.uploader_url,
                        description: 'Click to open the channel in the official YouTube Player'
                    }
                ],
                overview: video.description
            }],
            runtime: `${Math.floor((video.duration ?? 0) / 60)} min`,
            language: video.language,
            website: video.original_url,
            behaviorHints: {
                defaultVideoId: req.params.id
            }
        } });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Meta handler: ' + error);
        return res.json({ meta: {} });
    }
});

// Stremio Addon Stream Route
app.get('/:config/stream/:type/:id.json', async (req, res) => {
    try {
        if (!req.params.id?.startsWith(prefix)) throw new Error(`Unknown ID in Stream handler: "${req.params.id}"`);
        const userConfig = decryptConfig(req.params.config, false);
        const videoId = req.params.id?.slice(prefix.length);
        const host = req.get('host');
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const manifestUrl = encodeURIComponent(`${protocol}://${host}/${req.params.config}/manifest.json`);
        const command = `https://www.youtube.com/${videoId.startsWith('@') ? '' : 'watch?v='}${videoId}`;
        const video = await runYtDlpWithAuth(req.params.config, [
            command,
            '--playlist-end', '1',  // Only fetch the first video since this never needs more than one
            '--ignore-no-formats-error',
            ...(userConfig.markWatchedOnLoad ? ['--mark-watched'] : [])
        ]);
        const channel = video._type === 'playlist';
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
        return res.json({ streams: [
            ...(!channel ? [
                ...(video.formats ?? []).filter(src => userConfig.showBrokenLinks || (!src.format_id.startsWith('sb') && src.acodec !== 'none' && src.vcodec !== 'none')).toReversed().map(src => ({
                    name: `YT-DLP Player ${src.resolution}`,
                    url: src.url,
                    description: src.format,
                    subtitles: subtitles,
                    behaviorHints: {
                        ...(src.protocol !== 'https' || src.video_ext !== 'mp4' ? { notWebReady: true } : {}),
                        videoSize: src.filesize_approx,
                        filename: video.filename
                    }
                })), {
                    name: 'Stremio Player',
                    ytId: videoId,
                    description: 'Click to watch using Stremio\'s built-in YouTube Player'
                }, {
                    name: 'YouTube Player',
                    externalUrl: video.original_url,
                    description: 'Click to watch in the official YouTube Player'
                }
            ] : []), {
                name: 'YT-DLP Channel',
                externalUrl: `stremio:///discover/${manifestUrl}/movie/${encodeURIComponent(prefix + video.uploader_id)}`,
                description: 'Click to open the channel as a Catalog'
            }, {
                name: 'YouTube Channel',
                externalUrl: video.uploader_url,
                description: 'Click to open the channel in the official YouTube Player'
            }
        ] });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Stream handler: ' + error);
        return res.json({ streams: [] });
    }
});

// Configuration Page
app.get(['/', '/:config?/configure'], (req, res) => {
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
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
                <form id="config-form">
                    <div class="settings-section">
                        <h3>Cookies</h3>
                        <details class="instructions">
                            <summary>How to get your cookies.txt file</summary>
                            <ol>
                                <li>Go to <a href="https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies" target="_blank" rel="noopener noreferrer">github.com/yt-dlp/yt-dlp/wiki/Extractors</a> and follow the steps on the site for cookie exporting. (Make sure you are logged into your account if you want personalized content.)</li>
                                <li>Paste the content into the text area above.</li>
                            </ol>
                        </details>
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
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                    </div>
                    <div class="settings-section" id="addon-settings">
                        <h3>Settings</h3>
                        <div class="toggle-container">
                            <input type="checkbox" id="markWatchedOnLoad" name="markWatchedOnLoad">
                            <label for="markWatchedOnLoad">Mark watched on load</label>
                            <div class="setting-description">
                                When enabled, videos will be automatically marked as watched in your YouTube history when you open them in Stremio. This helps keep your YouTube watch history synchronized.
                            </div>
                        </div>
                        <div class="toggle-container">
                            <input type="checkbox" id="search" name="search" checked>
                            <label for="search">Allow searching</label>
                            <div class="setting-description">
                                When enabled, Stremio's search feature will also return YouTube results.
                            </div>
                        </div>
                        <div class="toggle-container">
                            <input type="checkbox" id="showBrokenLinks" name="showBrokenLinks">
                            <label for="showBrokenLinks">Show Broken Links</label>
                            <div class="setting-description">
                                When enabled, all resolutions found by YT-DLP will be returned, not just ones supported by Stremio. This may fix some issues if you encounter crashes on vidoes without it enabled.
                            </div>
                        </div>
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
                    { type: 'movie', id: ':ytrec', name: 'Discover' },
                    { type: 'movie', id: ':ytsubs', name: 'Subscriptions' },
                    { type: 'movie', id: ':ytwatchlater', name: 'Watch Later' },
                    { type: 'movie', id: ':ythistory', name: 'History' }
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
                function extractPlaylistId(input) {
                    let match;
                        // Channel URL
                    if (( match = input.match(/@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9]/) ) ||
                        // Playlist ID / Playlist URL
                        ( match = input.match(/PL([0-9A-F]{16}|[A-Za-z0-9_-]{32})/) ))
                        return decodeURIComponent(match[0].trim());
                        // Search URL
                    else if (input.match(/(?<=search_query=)[^&]+/))
                        return new URLSearchParams((input.split('?', 2)[1] ?? input).trim()).get('search_query');
                    // Search
                    return input.trim();
                }
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
                        idInput.addEventListener('change', () => pl.id = extractPlaylistId(idInput.value));
                        idCell.appendChild(idInput);
                        // Name
                        const nameCell = document.createElement('td');
                        const nameInput = document.createElement('input');
                        nameInput.value = pl.name;
                        nameInput.addEventListener('input', () => pl.name = nameInput.value.trim());
                        nameCell.appendChild(nameInput);
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
                        row.appendChild(actionsCell);
                        playlistTableBody.appendChild(row);
                    });
                }
                document.getElementById('add-playlist').addEventListener('click', () => {
                    playlists.push({ type: 'movie', id: '', name: '' });
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
                        const configString = encodeURIComponent(JSON.stringify({
                            encrypted: cookies.value,
                            catalogs: playlists.map(pl => ({ ...pl, id: ${JSON.stringify(prefix)} + pl.id })),
                            ...Object.fromEntries(
                                Array.from(addonSettings.querySelectorAll("input"))
                                    .map(x => [x.name, x.type === 'checkbox' ? x.checked : x.value]))}));
                        installStremio.href = \`stremio://${host}/\${configString}/manifest.json\`;
                        installUrlInput.value = \`${protocol}://${host}/\${configString}/manifest.json\`;
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
    console.log(`Access the configuration page at: https://${process.env.SPACE_HOST ?? ('localhost:' + PORT)}`);
});
    