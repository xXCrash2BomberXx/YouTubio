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
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedData) {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted data format');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

let counter = 0;
async function runYtDlpWithCookies(cookiesContent, argsArray) {
    const filename = path.join(tmpdir, `cookies-${Date.now()}-${counter++}.txt`);
    counter %= Number.MAX_SAFE_INTEGER;
    const fullArgs = [
        ...argsArray,
        '--skip-download',
        '--ignore-errors',
        '--no-warnings',
        '--no-cache-dir',
        '--cookies', filename];
    try {
        await fs.writeFile(filename, cookiesContent);
        return await ytDlpWrap.execPromise(fullArgs);
    } finally {
        try {
            await fs.unlink(filename);
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
        console.error('Encryption error:', error);
        res.status(500).send('Encryption failed');
    }
});

function decryptConfig(configParam, skipDecryption = false) {
    if (!configParam) {
        throw new Error('No config provided');
    }
    try {
        const configJson = Buffer.from(configParam, 'base64').toString('utf-8');
        const config = JSON.parse(configJson);
        if (!skipDecryption && config.encrypted) {
            const decryptedJson = decrypt(config.encrypted);
            const decryptedData = JSON.parse(decryptedJson);
            config.encrypted = decryptedData;
        }
        return config;
    } catch (error) {
        throw new Error('Failed to decrypt config: ' + error.message);
    }
}

// Stremio Addon Manifest Route
app.get('/:config/manifest.json', (req, res) => {
    let userConfig;
    try {
        userConfig = decryptConfig(req.params.config);
    } catch (error) {
        console.error('Error decrypting config for manifest handler:', error.message);
        return res.status(400);
    }
    
    res.json({
        id: 'youtubio.elfhosted.com',
        version: '0.1.0',
        name: 'YouTube',
        description: 'Watch YouTube videos, subscriptions, watch later, and history in Stremio.',
        resources: ['catalog', 'stream', 'meta'],
        types: ['movie', 'channel'],
        idPrefixes: [prefix],
        catalogs: (userConfig.catalogs.map(c => {
            c.extra = [ { name: 'skip', isRequired: false } ];
            return c;
        }) || [
            { type: 'movie', id: ':ytrec', name: 'Discover', extra: [ { name: 'skip', isRequired: false } ] },
            { type: 'movie', id: ':ytsubs', name: 'Subscriptions', extra: [ { name: 'skip', isRequired: false } ] },
            { type: 'movie', id: ':ytwatchlater', name: 'Watch Later', extra: [ { name: 'skip', isRequired: false } ] },
            { type: 'movie', id: ':ythistory', name: 'History', extra: [ { name: 'skip', isRequired: false } ] }
        ]).concat([
            // Add search unless explicitly disabled
            ...(userConfig.search || userConfig.search === undefined ? [
                { type: 'movie', id: ':ytsearch', name: 'YouTube', extra: [
                    { name: 'search', isRequired: true },
                    { name: 'skip', isRequired: false }
                ] },
                { type: 'channel', id: ':ytsearch_channel', name: 'YouTube', extra: [
                    { name: 'search', isRequired: true },
                    { name: 'skip', isRequired: false }
                ] }
            ] : [])
        ]),
        behaviorHints: {
            configurable: true
        }
    });
});

// Stremio Addon Catalog Route
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const query = queryObject.fromEntries(new URLSearchParams(req.params.extra))

    let channel = false;
    let command;
    // YT-DLP Search
    if ([':ytsearch'].includes(req.params.id)) {
        if (!query?.search) return res.json({ metas: [] });
        command = `ytsearch100:${query.search}`;
    // Channel Search
    } else if (channel.type === 'channel' && [':ytsearch_channel'].includes(req.params.id)) {
        if (!query?.search) return res.json({ metas: [] });
        command = `https://www.youtube.com/results?sp=EgIQAg%253D%253D&search_query=${encodeURIComponent(query.search)}`;
        channel = true;
    // YT-DLP Playlists
    } else if (req.params.id.startsWith(":") && [':ytfav', ':ytwatchlater', ':ytsubs', ':ythistory', ':ytrec', ':ytnotif'].includes(req.params.id)) {
        command = req.params.id;
    // Channels
    } else if (command = req.params.id.match(/@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9]/)) {
        command = `https://www.youtube.com/${command[0]}/videos`;
    // Playlists
    } else if (command = req.params.id.match(/PL([0-9A-F]{16}|[A-Za-z0-9_-]{32})/)) {
        command = `https://www.youtube.com/playlist?list=${command[0]}`;
    // Saved Channel Search
    } else if (req.params.type === 'channel') {
        command = `https://www.youtube.com/results?sp=EgIQAg%253D%253D&search_query=${encodeURIComponent(req.params.id)}`;
    // Saved YT-DLP Search
    } else {
        command = `ytsearch100:${decodeURIComponent(req.params.id)}`;
    }

    let userConfig;
    try {
        userConfig = decryptConfig(req.params.config);
    } catch (error) {
        console.error(`Error decrypting config for ${req.params.id}:`, error.message);
        return res.status(400).json({ metas: [] });
    }

    if (!userConfig.encrypted || !userConfig.encrypted.cookies) return res.json({ metas: [] });

    try {
        const skip = parseInt(query?.skip ?? 0);
        const data = JSON.parse(await runYtDlpWithCookies(userConfig.encrypted.cookies, [
            command,
            '--flat-playlist',
            '--dump-single-json',
            '--playlist-start', `${skip + 1}`,
            '--playlist-end', `${skip + 100}`
        ]));
        const metas = (data.entries || []).map(video => 
            video.id ? {
                id: `${prefix}${channel ? video.uploader_id : video.id}`,
                type: channel ? 'channel' : 'movie',
                name: video.title ?? 'Unknown Title',
                poster: `${channel ? protocol + ':' : ''}${video.thumbnail ?? video.thumbnails?.at(-1)?.url ?? `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`}`,
                posterShape: channel ? 'square' : 'landscape',
                description: video.description ?? '',
                releaseInfo: video.upload_date?.substring(0, 4) ?? ''
            } : null
        ).filter(meta => meta !== null);
        return res.json({ metas });
    } catch (err) {
        console.error(`Error in ${req.params.id} handler:`, err.message);
        return res.status(400).json({ metas: [] });
    }
});

// Stremio Addon Meta Route
app.get('/:config/meta/:type/:id.json', async (req, res) => {
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const manifestUrl = encodeURIComponent(`${protocol}://${host}/${req.params.config}/manifest.json`);

    if (!req.params.id.startsWith(prefix)) return res.json({ meta: {} });
    const videoId = req.params.id.slice(prefix.length);

    let userConfig;
    try {
        userConfig = decryptConfig(req.params.config);
    } catch (error) {
        console.error('Error decrypting config for meta:', error.message);
        return res.status(400).json({ meta: {} });
    }

    if (!userConfig.encrypted || !userConfig.encrypted.cookies) return res.json({ meta: {} });

    try {
        const videoData = JSON.parse(await runYtDlpWithCookies(userConfig.encrypted.cookies, [
            `https://www.youtube.com/${req.params.type === 'movie' ? 'watch?v=' : ''}${videoId}`,
            '-j',
            ...(userConfig.markWatchedOnLoad ? ['--mark-watched'] : [])
        ]));
        const title = videoData.title || 'Unknown Title';
        const thumbnail = videoData.thumbnail ?? videoData.thumbnails?.at(-1)?.url ?? `https://i.ytimg.com/vi/${videoData.id}/hqdefault.jpg`;
        const description = videoData.description || '';
        const released = new Date(videoData.timestamp * 1000).toISOString();
        return res.json({
            meta: videoData.id ? {
                id: req.params.id,
                type: 'movie',
                name: title,
                genres: videoData.tags,
                poster: thumbnail,
                posterShape: 'landscape',
                background: thumbnail,
                description: description,
                releaseInfo: videoData.upload_date ? videoData.upload_date.substring(0, 4) : null,
                released: released,
                videos: [{
                    id: req.params.id,
                    title: title,
                    released: released,
                    thumbnail: thumbnail,
                    streams: [
                        ...(req.params.type === 'movie' ? [
                            {
                                name: 'YT-DLP Player',
                                url: videoData.url,
                                description: 'Click to watch the scraped video from YT-DLP',
                                subtitles: Object.entries(videoData.subtitles || {}).map(([k, v]) => {
                                    const srt = v.find(x => x.ext == 'srt');
                                    return {
                                        id: srt.name,
                                        url: srt.url,
                                        lang: k
                                    };
                                }).concat(
                                    Object.entries(videoData.automatic_captions || {}).map(([k, v]) => {
                                        const srt = v.find(x => x.ext == 'srt');
                                        return {
                                            id: `Auto ${srt.name}`,
                                            url: srt.url,
                                            lang: k
                                        };
                                    })
                                ),
                                behaviorHints: {
                                    ...(videoData.protocol !== 'https' || videoData.video_ext !== 'mp4' ? { notWebReady: true } : {}),
                                    videoSize: videoData.filesize_approx,
                                    filename: videoData.filename
                                }
                            }, {
                                name: 'Stremio Player',
                                ytId: videoId,
                                description: 'Click to watch using Stremio\'s built-in YouTube Player'
                            }, {
                                name: 'YouTube Player',
                                externalUrl: videoData.original_url,
                                description: 'Click to watch in the official YouTube Player'
                            }
                        ] : []), {
                            name: 'View Channel',
                            externalUrl: `stremio:///discover/${manifestUrl}/movie/${encodeURIComponent(videoData.uploader_id)}`,
                            description: 'Click to open the channel as a Catalog'
                        }
                    ],
                    overview: description
                }],
                runtime: `${Math.floor(videoData.duration / 60)} min`,
                language: videoData.language,
                website: videoData.original_url,
                behaviorHints: {
                    defaultVideoId: req.params.id
                }
            } : {}
        });
    } catch (err) {
        console.error('Error in meta handler:', err.message);
        return res.status(400).json({ meta: {} });
    }
});

// Configuration Page
app.get(['/', '/:config?/configure'], (req, res) => {
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    let userConfig = {};
    try {
        if (req.params.config)
            userConfig = decryptConfig(req.params.config, true);
    } catch (error) {
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
                    <div class="settings-section" id="playlist-manager">
                        <h3>Cookies</h3>
                        <details class="instructions">
                            <summary>How to get your cookies.txt file</summary>
                            <ol>
                                <li>Go to <a href="https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies" target="_blank" rel="noopener noreferrer">github.com/yt-dlp/yt-dlp/wiki/Extractors</a> and follow the steps on the site for cookie exporting. (Make sure you are logged into your account if you want personalized content.)</li>
                                <li>Paste the content into the text area above.</li>
                            </ol>
                        </details>
                        <textarea id="cookie-data" placeholder="Paste the content of your cookies.txt file here..."></textarea>
                        <button type="button" id="clear-cookies" class="install-button action-button">Clear</button>
                    </div>
                    
                    <div class="settings-section" id="playlist-manager">
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
                const host = '${host}';
                const protocol = '${protocol}';
                
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
                
                let playlists = ${userConfig.catalogs ? JSON.stringify(userConfig.catalogs) : "JSON.parse(JSON.stringify(defaultPlaylists))"};
                ${userConfig.encrypted ? `cookies.value = '${userConfig.encrypted}'; cookies.disabled = true;` : ""}
                document.getElementById('markWatchedOnLoad').checked = ${userConfig.markWatchedOnLoad ? 'true' : 'false'};
                document.getElementById('search').checked = ${userConfig.search || userConfig.search === undefined ? 'true' : 'false'};
                
                document.getElementById('clear-cookies').addEventListener('click', () => {
                    cookies.value = "";
                    cookies.disabled = false;
                });
                
                function extractPlaylistId(input) {
                    let match;
                        // Channel URL
                    if (match = input.match(/@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9]/) ||
                        // Playlist ID / Playlist URL
                        match = input.match(/(?<=(list=)?)PL([0-9A-F]{16}|[A-Za-z0-9_-]{32})/) ||
                        // Search URL
                        match = input.match(/(?<=(search_query=)?)[a-zA-Z0-9!*()-_+*"<.>%]+/))
                        return match[0].trim();
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
                    if (!cookies.value || !cookies.value.trim()) {
                        errorDiv.textContent = "You must provide cookies to use this addon";
                        errorDiv.style.display = 'block';
                        return;
                    }
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
                                    cookies: cookies.value,
                                })
                            });
                            if (!encryptResponse.ok) {
                                throw new Error(await encryptResponse.text() || 'Encryption failed');
                            }
                            cookies.value = await encryptResponse.text();
                            cookies.disabled = true;
                        }
                        
                        const configString = btoa(JSON.stringify({
                            encrypted: cookies.value,
                            catalogs: playlists,
                            ...Object.fromEntries(
                                Array.from(addonSettings.querySelectorAll("input"))
                                    .map(x => [x.name, x.type === 'checkbox' ? x.checked : x.value])
                            )
                        }));
                        
                        installStremio.href = \`stremio://\${host}/\${configString}/manifest.json\`;
                        installUrlInput.value = \`\${protocol}://\${host}/\${configString}/manifest.json\`;
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
    console.error('Express error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start the Server
app.listen(PORT, () => {
    console.log(`Addon server running on port ${PORT}`);
    if (!process.env.ENCRYPTION_KEY) {
        console.warn('WARNING: Using random encryption key. Set ENCRYPTION_KEY environment variable for production.');
        console.log('Generated key (base64):', ENCRYPTION_KEY.toString('base64'));
    }
    if (process.env.SPACE_HOST) {
        console.log(`Access the configuration page at: https://${process.env.SPACE_HOST}`);
    } else {
        console.log(`Access the configuration page at: http://localhost:${PORT}`);
    }
});
