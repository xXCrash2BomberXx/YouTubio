#!/usr/bin/env node

const express = require('express');
const qs = require('querystring');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs').promises;
const tmp = require('tmp');

const ytDlpWrap = new YTDlpWrap();
const PORT = process.env.PORT || 7000;

const prefix = 'yt_id:';

const manifest = {
    id: 'xxcrashbomberxx-youtube.hf.space',
    version: '0.1.0',
    name: 'YouTube',
    description: 'Watch YouTube videos, subscriptions, watch later, and history in Stremio.',
    logo: 'https://www.youtube.com/s/desktop/d743f786/img/favicon_144x144.png',
    resources: ['catalog', 'stream', 'meta'],
    types: ['movie'],
    idPrefixes: [prefix],
    catalogs: [
        { type: 'movie', id: 'youtube.discover', name: 'Discover' },
        { type: 'movie', id: 'youtube.subscriptions', name: 'Subscriptions' },
        { type: 'movie', id: 'youtube.watchlater', name: 'Watch Later' },
        { type: 'movie', id: 'youtube.history', name: 'History' },
        { type: 'movie', id: 'youtube.search', name: 'YouTube', extra: [{ name: 'search', isRequired: true }] }
    ],
};

async function runYtDlpWithCookies(cookiesContent, argsArray) {
    return new Promise((resolve, reject) => {
        tmp.file({ prefix: 'cookies-', postfix: '.txt', discardDescriptor: true, keep: false }, async (err, path, fd, cleanup) => {
            if (err) return reject(err);
            try {
                await fs.writeFile(path, cookiesContent);
                const fullArgs = [
                    ...argsArray,
                    '--no-check-certificate',
                    '--skip-download',
                    '--ignore-errors',
                    '--no-warnings',
                    '--no-cache-dir',
                    '--cookies', path];
                const output = await ytDlpWrap.execPromise(fullArgs);
                cleanup();
                resolve(output);
            } catch (error) {
                cleanup();
                reject(error);
            }
        });
    });
}

const app = express();
app.use(express.urlencoded({ extended: true }));

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Stremio Addon Manifest Route
app.get('/:config?/manifest.json', (req, res) => {
    res.json(manifest);
});

// Stremio Addon Resource Route
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
    const args = {
        type: req.params.type,
        id: req.params.id,
        extra: (req.params.extra ? qs.parse(req.params.extra) : {})
    };
    let command;
    switch (args.id) {
        case 'youtube.search':
            if (!args.extra || !args.extra.search) return res.json({ metas: [] });
            command = `ytsearch50:${args.extra.search}`;
            break;
        case 'youtube.discover':
            command = ':ytrec';
            break;
        case 'youtube.subscriptions':
            command = ':ytsubs';
            break;
        case 'youtube.watchlater':
            command = ':ytwatchlater';
            break;
        case 'youtube.history':
            command = ':ythistory';
            break;
        default:
            return res.json({ metas: [] });
    }
    let userConfig = {};
    try {
        const jsonString = Buffer.from(req.params.config, 'base64').toString('utf-8');
        userConfig = JSON.parse(jsonString);
    } catch (e) {
        console.error("Error parsing config for catalog:", e);
        return res.status(400).json({ metas: [] });
    }
    if (!userConfig.cookies) return res.json({ metas: [] });
    try {
        const data = JSON.parse(await runYtDlpWithCookies(userConfig.cookies, [
            command,
            '--flat-playlist',
            '--dump-single-json',
            '--playlist-end', '50'
        ]));
        const metas = (data.entries || []).map(video => 
            video.id ? {
                id: `${prefix}${video.id}`,
                type: 'movie',
                name: video.title || 'Unknown Title',
                poster: video.thumbnails?.at(-1)?.url ?? video.thumbnail ?? `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
                posterShape: 'landscape',
                description: video.description || '',
                releaseInfo: video.upload_date ? video.upload_date.substring(0, 4) : null
            } : null
        ).filter(meta => meta !== null);
        return res.json({ metas });
    } catch (err) {
        console.error(`Error in ${args.id} handler:`, err.message);
        return res.status(400).json({ metas: [] });
    }
});

// Stremio Addon Meta Route
app.get('/:config?/meta/:type/:id.json', async (req, res) => {
    const args = {
        type: req.params.type,
        id: req.params.id,
    };
    if (!args.id.startsWith(prefix)) return res.json({ meta: {} });
    const videoId = args.id.slice(prefix.length);
    let userConfig = {};
    try {
        const jsonString = Buffer.from(req.params.config, 'base64').toString('utf-8');
        userConfig = JSON.parse(jsonString);
    } catch (e) {
        console.error("Error parsing config for meta:", e);
        return res.status(400).json({ meta: {} });
    }
    if (!userConfig.cookies) return res.json({ meta: {} });
    try {
        const videoData = JSON.parse(await runYtDlpWithCookies(userConfig.cookies, [
            `https://www.youtube.com/watch?v=${videoId}`,
            '-j'
        ]));
        console.log(videoData);
        const title = videoData.title || 'Unknown Title';
        const thumbnail = videoData.thumbnail ?? videoData.thumbnails?.at(-1)?.url ?? `https://i.ytimg.com/vi/${videoData.id}/hqdefault.jpg`;
        const description = videoData.description || '';
        const released = new Date(videoData.timestamp * 1000).toISOString();
        return res.json({
            meta: videoData.id ? {
                id: args.id,
                type: 'movie',
                name: title,
                genres: videoData.tags,
                poster: thumbnail,
                posterShape: 'landscape',
                description: description,
                releaseInfo: videoData.upload_date ? videoData.upload_date.substring(0, 4) : null,
                released: released,
                videos: [{
                    id: args.id,
                    title: title,
                    released: released,
                    thumbnail: thumbnail,
                    streams: [{
                        name: 'YT-DLP Player',
                        url: videoData.url,
                        description: 'Click to watch the scraped video from YT-DLP',
                        ...(videoData.protocol !== 'https' || videoData.video_ext !== 'mp4' ? { notWebReady: true } : {}),
                        videoSize: videoData.filesize_approx,
                        filename: videoData.filename
                    }, {
                        name: 'Stremio Player',
                        ytId: videoId,
                        description: 'Click to watch using Stremio\'s builtin YouTube Player'
                    }, {
                        name: 'YouTube Player',
                        externalUrl: videoData.original_url,
                        description: 'Click to watch in the official YouTube Player'
                    }],
                    overview: description
                }],
                runtime: `${Math.floor(videoData.duration / 60} min`,
                language: videoData.language,
                website: videoData.original_url,
                defaultVideoId: args.id
            } : {}
        });
    } catch (err) {
        console.error('Error in meta handler:', err.message);
        return res.status(400).json({ meta: {} });
    }
});

// Serve the configuration page at the root
app.get('/', (req, res) => {
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>YouTube Addon Configuration</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; text-align: center; padding: 40px; background: #f4f4f8; color: #333; }
                .container { max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                h1 { color: #d92323; }
                p { font-size: 1.1em; line-height: 1.6; }
                textarea { width: 100%; height: 150px; padding: 10px; margin-top: 15px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box; resize: vertical; }
                .install-button { display: inline-block; margin-top: 20px; padding: 15px 30px; background-color: #5835b0; color: white; text-decoration: none; font-size: 1.2em; border-radius: 5px; transition: background-color 0.3s; }
                .install-button:hover { background-color: #4a2c93; }
                .url-input { width: 100%; padding: 10px; margin-top: 15px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box; }
                #copy-btn { padding: 10px 15px; margin-top: 10px; border-radius: 4px; border: none; background-color: #007bff; color: white; cursor: pointer; }
                .instructions { text-align: left; margin-top: 25px; padding: 15px; border: 1px solid #ddd; border-radius: 5px; background: #f9f9f9; }
                .instructions summary { font-weight: bold; cursor: pointer; }
                .instructions ul { padding-left: 20px; }
                .instructions li { margin-bottom: 8px; }
                #results { margin-top: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>YouTube Addon for Stremio</h1>
                <p>To see your subscriptions, watch history, and watch later playlists, paste the content of your <code>cookies.txt</code> file below.</p>
                <form id="config-form">
                    <textarea id="cookie-data" placeholder="Paste the content of your cookies.txt file here..."></textarea>
                    <button type="submit" class="install-button">Generate Install Link</button>
                </form>
                <div id="results" style="display:none;">
                    <p>Click the button below to install the addon in Stremio:</p>
                    <a href="#" id="install-link" class="install-button">Install Addon</a>
                    <p>If that doesn't work, copy the URL and paste it into the Stremio search bar:</p>
                    <input type="text" id="install-url" readonly class="url-input">
                    <button id="copy-btn">Copy URL</button>
                </div>
                <details class="instructions">
                    <summary>How to get your cookies.txt file</summary>
                    <ol>
                        <li>Install a browser extension for exporting cookies:
                            <ul>
                                <li><a href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc" target="_blank" rel="noopener noreferrer">Get cookies.txt LOCALLY for Chrome</a></li>
                                <li><a href="https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/" target="_blank" rel="noopener noreferrer">cookies.txt for Firefox</a></li>
                            </ul>
                        </li>
                        <li>Go to <a href="https://www.youtube.com" target="_blank" rel="noopener noreferrer">youtube.com</a> and make sure you are logged into your account.</li>
                        <li>Click the extension's icon in your browser's toolbar.</li>
                        <li>Click "Export" or "Download" to save the <strong>cookies.txt</strong> file.</li>
                        <li>Open the file and copy its entire content.</li>
                        <li>Paste the content into the text area above.</li>
                    </ol>
                </details>
            </div>
            <script>
                const host = '${host}';
                const protocol = '${protocol}';
                document.getElementById('config-form').addEventListener('submit', function(event) {
                    event.preventDefault();
                    const cookies = document.getElementById('cookie-data').value;
                    const userConfig = {};
                    if (cookies && cookies.trim()) {
                        userConfig.cookies = cookies;
                    }
                    const configString = btoa(JSON.stringify(userConfig));
                    const installUrl = \`\${protocol}://\${host}/\${configString}/manifest.json\`;
                    const installLink = document.getElementById('install-link');
                    installLink.href = \`stremio://installaddon/\${installUrl}\`;
                    const installUrlInput = document.getElementById('install-url');
                    installUrlInput.value = installUrl;
                    document.getElementById('results').style.display = 'block';
                });

                document.getElementById('copy-btn').addEventListener('click', function() {
                    const urlInput = document.getElementById('install-url');
                    urlInput.select();
                    document.execCommand('copy');
                    this.textContent = 'Copied!';
                    setTimeout(() => { this.textContent = 'Copy URL'; }, 2000);
                });

                // Generate a default install link on page load for users who don't want to log in
                const defaultConfigString = btoa(JSON.stringify({}));
                const defaultInstallUrl = \`stremio://installaddon/\${protocol}://\${host}/\${defaultConfigString}/manifest.json\`;
                const installLink = document.getElementById('install-link');
                const installUrlInput = document.getElementById('install-url');
                installLink.href = defaultInstallUrl;
                installUrlInput.value = \`\${protocol}://\${host}/\${defaultConfigString}/manifest.json\`;
            </script>
        </body>
        </html>
    `);
});

// Start the server
app.listen(PORT, () => {
    console.log(`Addon server running on port ${PORT}`);
    if (process.env.SPACE_HOST) {
        console.log(`Access the configuration page at: https://${process.env.SPACE_HOST}`);
    } else {
        console.log(`Access the configuration page at: http://localhost:${PORT}`);
    }
});
