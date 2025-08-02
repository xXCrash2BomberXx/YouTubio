#!/usr/bin/env node

const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const express = require('express');
const qs = require('querystring');
const YTDlpWrap = require('yt-dlp-wrap').default;

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

/*
// Middleware for CORS and logging
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    console.log(`Request: ${req.method} ${req.url}`);
    next();
});
*/

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
            const subscriptionsResponse = await youtube.subscriptions.list({
                part: 'snippet',
                mine: true,
                maxResults: 50 // Number of subscriptions
            });
            if (subscriptionsResponse.data.items.length > 0) {
                const videoPromises = subscriptionsResponse.data.items.map(async (sub) => {
                    const channelId = sub.snippet.resourceId.channelId;
                    const channelDetails = await youtube.channels.list({
                        part: 'contentDetails',
                        id: channelId
                    });
                    const uploadsPlaylistId = channelDetails.data.items[0]?.contentDetails?.relatedPlaylists?.uploads;
                    if (uploadsPlaylistId) {
                        const videosResponse = await youtube.playlistItems.list({
                            part: 'snippet',
                            playlistId: uploadsPlaylistId,
                            maxResults: 10 // Number of recent videos per subscription
                        });
                        return videosResponse.data.items;
                    }
                    return [];
                });
                const videoArrays = await Promise.all(videoPromises);
                const allVideos = videoArrays.flat();
                allVideos.sort((a, b) => new Date(b.snippet.publishedAt) - new Date(a.snippet.publishedAt));
                return res.json({
                    metas: allVideos
                        .map(toMeta)
                        .filter(meta => meta !== null)
                });
            } else {
                return res.json({ metas: [] });
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
        try {
            const videoInfo = await ytDlpWrap.getVideoInfo(`https://www.youtube.com/watch?v=${videoId}`);
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
        const userConfig = { tokens };
        const configString = Buffer.from(JSON.stringify(userConfig)).toString('base64');
        const host = req.get('host');
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const installUrl = `${protocol}://${host}/${configString}/manifest.json`;
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
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Success!</h1>
                    <p>Your addon is now configured. Click the button below to install the configured addon in Stremio.</p>
                    <a href="stremio://installaddon/${installUrl}" class="install-button">Install Addon in Stremio</a>
                    <p>If that doesn't work, copy the URL below and paste it into the Stremio search bar:</p>
                    <input type="text" value="${installUrl}" id="install-url" readonly class="url-input">
                    <button id="copy-btn">Copy URL</button>
                </div>
                <script>
                    document.getElementById('copy-btn').addEventListener('click', function() {
                        const urlInput = document.getElementById('install-url');
                        urlInput.select();
                        document.execCommand('copy');
                        this.textContent = 'Copied!';
                        setTimeout(() => { this.textContent = 'Copy URL'; }, 2000);
                    });
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
