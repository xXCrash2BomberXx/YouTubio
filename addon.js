#!/usr/bin/env node

const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const express = require('express');
const qs = require('querystring');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const ytDlpWrap = new YTDlpWrap();


const PORT = process.env.PORT || 7000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SPACE_HOST = process.env.SPACE_HOST;
const REDIRECT_URI = `https://${SPACE_HOST}/oauth2callback`;

const manifest = {
    id: 'xxcrashbomberxx-youtube.hf.space',
    version: '0.1.0',
    name: 'YouTube',
    description: 'Watch YouTube videos, subscriptions, watch later, and history in Stremio.',
    logo: 'https://www.youtube.com/s/desktop/d743f786/img/favicon_144x144.png',
    resources: ['catalog', 'stream', 'meta'],
    types: ['channel'],
    idPrefixes: ['yt:'],
    catalogs: [
        { type: 'channel', id: 'youtube.discover', name: 'Discover' },
        { type: 'channel', id: 'youtube.subscriptions', name: 'Subscriptions' },
        { type: 'channel', id: 'youtube.watchlater', name: 'Watch Later' },
        { type: 'channel', id: 'youtube.history', name: 'History' },
        { type: 'channel', id: 'youtube.search', name: 'YouTube', extra: [{ name: 'search', isRequired: true }] },
    ],
    config: {
        "type": "url",
        "label": "Login with Google",
        "url": `https://${SPACE_HOST}`
    }
};

// Helper function to get an authenticated YouTube API client
const getYouTubeClient = (config) => {
    if (!config || !config.tokens) {
        return google.youtube({ version: 'v3', auth: GOOGLE_CLIENT_ID });
    }
    const oAuth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
    oAuth2Client.setCredentials(config.tokens);
    return google.youtube({ version: 'v3', auth: oAuth2Client });
};

// Helper to convert YouTube video to Stremio meta format
const toMeta = (video) => {
    const videoId = video.id?.videoId || video.id || video.snippet?.resourceId?.videoId;
    const snippet = video.snippet;
    if (!videoId || !snippet) {
        console.warn('Invalid video object, skipping:', video);
        return null;
    }
    const thumbnails = snippet.thumbnails || {};
    const posterUrl = (thumbnails.maxres || thumbnails.standard || thumbnails.high || thumbnails.medium || thumbnails.default || {}).url;
    return {
        id: `yt:${videoId}`,
        type: 'channel',
        name: snippet.title || 'Unknown Title',
        poster: posterUrl,
        posterShape: 'landscape',
        description: snippet.description || '',
        releaseInfo: snippet.publishedAt ? snippet.publishedAt.substring(0, 4) : null
    };
};

const app = express();

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Stremio Addon Manifest Route
app.get('/:config/manifest.json', (req, res) => {
    res.json(manifest);
});

// Stremio Addon Resource Route
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
    const args = {
        type: req.params.type,
        id: req.params.id,
        extra: (req.params.extra ? qs.parse(req.params.extra) : {})
    };
    try {
        const jsonString = Buffer.from(req.params.config, 'base64').toString('utf-8');
        const userConfig = JSON.parse(jsonString);
        const youtube = getYouTubeClient(userConfig);
        // Handle search catalogs
        if (args.id === 'youtube.search' && args.extra && args.extra.search) {
            const response = await youtube.search.list({ 
                part: 'snippet', 
                q: args.extra.search, 
                type: 'video', 
                maxResults: 50 
            });
            return res.json({metas: response.data.items
                .map(toMeta)
                .filter(meta => meta !== null)});
        }
        // Handle discover catalog
        else if (args.id === 'youtube.discover') {
            const popular = await youtube.videos.list({ 
                part: 'snippet,contentDetails', 
                chart: 'mostPopular', 
                regionCode: 'US', 
                maxResults: 50 
            });
            return res.json({metas: popular.data.items
                .map(toMeta)
                .filter(meta => meta !== null)});
        }
        // Handle subscriptions catalog
        else if (args.id === 'youtube.subscriptions') {
            if (!userConfig.cookies) {
                return res.json({ metas: [] });
            }
            let cookieFile = null;
            try {
                const tempDir = os.tmpdir();
                cookieFile = path.join(tempDir, `cookies_${Date.now()}.txt`);
                await fs.writeFile(cookieFile, userConfig.cookies);
                const subsInfo = await ytDlpWrap.getVideoInfo([
                    'https://www.youtube.com/feed/subscriptions',
                    '--cookies', cookieFile,
                    '-J'
                ]);
                const subsData = JSON.parse(subsInfo);
                const metas = subsData.entries.map(video => {
                    if (!video) return null;
                    const posterUrl = video.thumbnail || (video.thumbnails && video.thumbnails[0] ? video.thumbnails[0].url : null);
                    const releaseYear = video.upload_date ? video.upload_date.substring(0, 4) : null;
                    return {
                        id: `yt:${video.id}`,
                        type: 'channel',
                        name: video.title || 'Unknown Title',
                        poster: posterUrl,
                        posterShape: 'landscape',
                        description: video.description || '',
                        releaseInfo: releaseYear
                    };
                }).filter(meta => meta !== null);
                return res.json({ metas });
            } catch (err) {
                console.error('Error in subscriptions handler:', err.message);
                return res.json({ metas: [] });
            } finally {
                if (cookieFile) {
                    await fs.unlink(cookieFile).catch(err => console.error('Error deleting temp cookie file:', err));
                }
            }
        }
        // Handle watch later catalog
        else if (args.id === 'youtube.watchlater') {
            if (!userConfig.cookies) {
                return res.json({ metas: [] });
            }
        
            let cookieFile = null;
            try {
                const tempDir = os.tmpdir();
                cookieFile = path.join(tempDir, `cookies_${Date.now()}.txt`);
                await fs.writeFile(cookieFile, userConfig.cookies);
                const playlistInfo = await ytDlpWrap.getVideoInfo([
                    'https://www.youtube.com/playlist?list=WL',
                    '--cookies', cookieFile,
                    '-J'
                ]);
                const playlistData = JSON.parse(playlistInfo);
                const metas = playlistData.entries.map(video => {
                    if (!video) return null;
                    const posterUrl = video.thumbnail || (video.thumbnails && video.thumbnails[0] ? video.thumbnails[0].url : null);
                    const releaseYear = video.upload_date ? video.upload_date.substring(0, 4) : null;
                    return {
                        id: `yt:${video.id}`,
                        type: 'channel',
                        name: video.title || 'Unknown Title',
                        poster: posterUrl,
                        posterShape: 'landscape',
                        description: video.description || '',
                        releaseInfo: releaseYear
                    };
                }).filter(meta => meta !== null);
                return res.json({ metas });
            } catch (err) {
                console.error('Error in watchlater handler:', err.message);
                return res.json({ metas: [] });
            } finally {
                if (cookieFile) {
                    await fs.unlink(cookieFile).catch(err => console.error('Error deleting temp cookie file:', err));
                }
            }
        }
        // Handle Watch History catalog
        else if (args.id === 'youtube.history') {
            if (!userConfig.cookies) {
                return res.json({ metas: [] });
            }
            let cookieFile = null;
            try {
                const tempDir = os.tmpdir();
                cookieFile = path.join(tempDir, `cookies_${Date.now()}.txt`);
                await fs.writeFile(cookieFile, userConfig.cookies);
                const historyInfo = await ytDlpWrap.getVideoInfo([
                    'https://www.youtube.com/feed/history',
                    '--cookies', cookieFile,
                    '-J'
                ]);
                const historyData = JSON.parse(historyInfo);
                const metas = historyData.entries.map(video => {
                    if (!video) return null;
                    const posterUrl = video.thumbnail || (video.thumbnails && video.thumbnails[0] ? video.thumbnails[0].url : null);
                    const releaseYear = video.upload_date ? video.upload_date.substring(0, 4) : null;
                    return {
                        id: `yt:${video.id}`,
                        type: 'channel',
                        name: video.title || 'Unknown Title',
                        poster: posterUrl,
                        posterShape: 'landscape',
                        description: video.description || '',
                        releaseInfo: releaseYear
                    };
                }).filter(meta => meta !== null);
                return res.json({ metas });
            } catch (err) {
                console.error('Error in history handler:', err.message);
                return res.json({ metas: [] });
            } finally {
                if (cookieFile) {
                    await fs.unlink(cookieFile).catch(err => console.error('Error deleting temp cookie file:', err));
                }
            }
        }
    } catch (err) {
        console.error('Error in catalog handler:', err.message);
        console.error('Full error:', err);
        return res.json({metas: []});
    }
});

// Stremio Addon Meta Route
app.get('/:config/meta/:type/:id.json', async (req, res) => {
    const args = {
        type: req.params.type,
        id: req.params.id,
    };
    if (args.id.startsWith('yt:')) {
        const videoId = args.id.slice(3);
        try {
            const jsonString = Buffer.from(req.params.config, 'base64').toString('utf-8');
            const userConfig = JSON.parse(jsonString);
            const youtube = getYouTubeClient(userConfig);
            const response = await youtube.videos.list({ 
                part: 'snippet,contentDetails', 
                id: videoId 
            });
            if (response.data.items.length > 0) {
                const meta = toMeta(response.data.items[0]);
                return res.json({ meta: meta || {} });
            }
        } catch (err) {
            console.error('Error in meta handler:', err.message);
        }
    }
    return res.json({ meta: {} });
});

// Stremio Addon Stream Route
app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const args = {
        type: req.params.type,
        id: req.params.id,
    };
    if (args.id.startsWith('yt:')) {
        const videoId = args.id.slice(3);
        let cookieFile = null;
        try {
            const jsonString = Buffer.from(req.params.config, 'base64').toString('utf-8');
            const userConfig = JSON.parse(jsonString);

            const ytDlpArgs = [];
            if (userConfig.cookies) {
                const tempDir = os.tmpdir();
                cookieFile = path.join(tempDir, `cookies_${Date.now()}.txt`);
                await fs.writeFile(cookieFile, userConfig.cookies);
                ytDlpArgs.push('--cookies', cookieFile);
            }

            const videoInfo = await ytDlpWrap.getVideoInfo([`https://www.youtube.com/watch?v=${videoId}`].concat(ytDlpArgs));
            const format = videoInfo.formats.find(f => f.format_id === 'best' || (f.acodec !== 'none' && f.vcodec !== 'none'));
            if (format) {
                res.json({
                    streams: [{
                        title: 'YouTube Stream',
                        url: format.url,
                        description: 'Click to watch on YouTube'
                    }]
                });
            } else {
                 res.json({ streams: [] });
            }
        } catch (err) {
            console.error('Error getting video info:', err.message);
            res.json({ streams: [] });
        } finally {
            if (cookieFile) {
                await fs.unlink(cookieFile).catch(err => console.error('Error deleting temp cookie file:', err));
            }
        }
    } else {
        res.json({ streams: [] });
    }
});


// Create OAuth2 client only if credentials are available
let oAuth2Client;
if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    oAuth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}

// Serve the configuration page at the root
app.get('/', (req, res) => {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/youtube.readonly'],
    });
    return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>YouTube Addon Setup</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; text-align: center; padding: 40px; background: #f4f4f8; color: #333; }
                .container { max-width: 500px; margin: auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                h1 { color: #d92323; }
                p { font-size: 1.1em; line-height: 1.6; }
                .login-button { display: inline-block; padding: 12px 25px; border: none; background-color: #ff0000; color: white; border-radius: 4px; font-size: 1.1em; cursor: pointer; text-decoration: none; transition: background-color 0.3s; }
                .login-button:hover { background-color: #cc0000; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>YouTube Addon for Stremio</h1>
                <p>To see your subscriptions, watch history, and watch later playlists, you need to log in with your Google account.</p>
                <a href="${authUrl}" class="login-button">Login with Google</a>
            </div>
        </body>
        </html>
    `);
});

// OAuth2 callback handler
app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oAuth2Client.getToken(code);
        const host = req.get('host');
        const protocol = host.includes('localhost') ? 'http' : 'https';
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Addon Installed</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; text-align: center; padding: 40px; background: #f4f4f8; color: #333; }
                    .container { max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                    h1 { color: #28a745; }
                    .install-button { display: inline-block; margin-top: 20px; padding: 15px 30px; background-color: #5835b0; color: white; text-decoration: none; font-size: 1.2em; border-radius: 5px; transition: background-color 0.3s; }
                    .install-button:hover { background-color: #4a2c93; }
                    .url-input { width: 100%; padding: 10px; margin-top: 15px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box; }
                    #copy-btn { padding: 10px 15px; margin-top: 10px; border-radius: 4px; border: none; background-color: #007bff; color: white; cursor: pointer; }
                    .cookie-container { margin-top: 20px; }
                    .instructions { text-align: left; margin-top: 25px; padding: 15px; border: 1px solid #ddd; border-radius: 5px; background: #f9f9f9; }
                    .instructions summary { font-weight: bold; cursor: pointer; }
                    .instructions ul { padding-left: 20px; }
                    .instructions li { margin-bottom: 8px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Success!</h1>
                    <p>Your addon is now configured. To enable additional features, you can optionally upload your cookies.txt file.</p>
                    <div class="cookie-container">
                        <label for="cookie-file"><b>Optional:</b> Upload cookies.txt:</label>
                        <input type="file" id="cookie-file" accept=".txt">
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
                            <li>Click the extension's icon in your browser's toolbar (it might look like a cookie or a download icon).</li>
                            <li>Click the "Export" or "Download" button to save the <strong>cookies.txt</strong> file to your computer.</li>
                            <li>Upload that file using the input field above.</li>
                        </ol>
                    </details>

                    <a href="#" id="install-link" class="install-button">Install Addon in Stremio</a>
                    <p>If that doesn't work, copy the URL below and paste it into the Stremio search bar:</p>
                    <input type="text" id="install-url" readonly class="url-input">
                    <button id="copy-btn">Copy URL</button>
                </div>
                <script>
                    const tokens = ${JSON.stringify(tokens)};
                    const host = '${host}';
                    const protocol = '${protocol}';

                    function generateInstallUrl(cookies) {
                        const userConfig = {
                            tokens: tokens,
                        };
                        if (cookies) {
                            userConfig.cookies = cookies;
                        }
                        const configString = btoa(JSON.stringify(userConfig));
                        const installUrl = \`\${protocol}://\${host}/\${configString}/manifest.json\`;

                        const installLink = document.getElementById('install-link');
                        installLink.href = \`stremio://installaddon/\${installUrl}\`;

                        const installUrlInput = document.getElementById('install-url');
                        installUrlInput.value = installUrl;
                    }

                    document.getElementById('cookie-file').addEventListener('change', function(event) {
                        const file = event.target.files[0];
                        if (file) {
                            const reader = new FileReader();
                            reader.onload = function(e) {
                                const cookies = e.target.result;
                                generateInstallUrl(cookies);
                            };
                            reader.readAsText(file);
                        }
                    });

                    document.getElementById('copy-btn').addEventListener('click', function() {
                        const urlInput = document.getElementById('install-url');
                        urlInput.select();
                        document.execCommand('copy');
                        this.textContent = 'Copied!';
                        setTimeout(() => { this.textContent = 'Copy URL'; }, 2000);
                    });

                    // Generate the initial URL without cookies
                    generateInstallUrl(null);
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Error getting token:', error);
        return res.status(500).send('Failed to retrieve access token. Please try again.');
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Addon server running on port ${PORT}`);
    console.log(`Access it at: https://${SPACE_HOST}`);
});
