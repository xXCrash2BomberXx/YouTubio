#!/usr/bin/env node

const express = require('express');
const qs = require('querystring');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const tmpdir = require('os').tmpdir();
const ytDlpWrap = new YTDlpWrap();
const PORT = process.env.PORT || 7000;
const cookieLimit = 7500;
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

const manifest = {
    id: 'youtubio.elfhosted.com',
    version: '0.1.0',
    name: 'YouTube',
    description: 'Watch YouTube videos, subscriptions, watch later, and history in Stremio.',
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

let counter = 0;
async function runYtDlpWithCookies(cookiesContent, argsArray) {
    const filename = path.join(tmpdir, `cookies-${Date.now()}-${counter++}.txt`);
    counter %= Number.MAX_SAFE_INTEGER;
    const fullArgs = [
        ...argsArray,
        '--no-check-certificate',
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

// Config encryption endpoint
app.post('/encrypt', (req, res) => {
    try {
        const configData = req.body;
        
        if (!configData.cookies || !configData.cookies.trim()) {
            return res.status(400).json({ error: 'Cookies data is required' });
        }
        
        if (configData.cookies.length > cookieLimit) {
            return res.status(400).json({ 
                error: `Cookie data length ${configData.cookies.length} exceeds limit of ${cookieLimit}` 
            });
        }
        
        const configJson = JSON.stringify(configData);
        const encryptedData = encrypt(configJson);
        const configString = Buffer.from(encryptedData).toString('base64');
        
        res.json({ 
            success: true, 
            config: configString 
        });
    } catch (error) {
        console.error('Encryption error:', error);
        res.status(500).json({ error: 'Encryption failed' });
    }
});

function decryptConfig(configParam) {
    if (!configParam) {
        throw new Error('No config provided');
    }
    
    if (configParam.length > cookieLimit * 2) { // Account for encryption overhead
        throw new Error(`Config data too large`);
    }
    
    try {
        const encryptedData = Buffer.from(configParam, 'base64').toString('utf-8');
        const decryptedJson = decrypt(encryptedData);
        return JSON.parse(decryptedJson);
    } catch (error) {
        throw new Error('Failed to decrypt config: ' + error.message);
    }
}

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
    
    let userConfig;
    try {
        userConfig = decryptConfig(req.params.config);
    } catch (error) {
        console.error(`Error decrypting config for ${args.id}:`, error.message);
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
                poster: video.thumbnail ?? video.thumbnails?.at(-1)?.url ?? `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
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
    
    let userConfig;
    try {
        userConfig = decryptConfig(req.params.config);
    } catch (error) {
        console.error('Error decrypting config for meta:', error.message);
        return res.status(400).json({ meta: {} });
    }
    
    if (!userConfig.cookies) return res.json({ meta: {} });
    
    try {
        const videoData = JSON.parse(await runYtDlpWithCookies(userConfig.cookies, [
            `https://www.youtube.com/watch?v=${videoId}`,
            '-j'
        ]));
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
                background: thumbnail,
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
                        behaviorHints: {
                            ...(videoData.protocol !== 'https' || videoData.video_ext !== 'mp4' ? { notWebReady: true } : {}),
                            videoSize: videoData.filesize_approx,
                            filename: videoData.filename
                        }
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
                runtime: `${Math.floor(videoData.duration / 60)} min`,
                language: videoData.language,
                website: videoData.original_url,
                behaviorHints: {
                    defaultVideoId: args.id
                }
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
            <title>YouTubio | ElfHosted</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; text-align: center; padding: 40px; background: #f4f4f8; color: #333; }
                .container { max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                h1 { color: #d92323; }
                p { font-size: 1.1em; line-height: 1.6; }
                textarea { width: 100%; height: 150px; padding: 10px; margin-top: 15px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box; resize: vertical; }
                .install-button { display: inline-block; margin-top: 20px; padding: 15px 30px; background-color: #5835b0; color: white; text-decoration: none; font-size: 1.2em; border-radius: 5px; transition: background-color 0.3s; border: none; cursor: pointer; }
                .install-button:hover { background-color: #4a2c93; }
                .install-button:disabled { background-color: #ccc; cursor: not-allowed; }
                .url-input { width: 100%; padding: 10px; margin-top: 15px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box; }
                #copy-btn { padding: 10px 15px; margin-top: 10px; border-radius: 4px; border: none; background-color: #007bff; color: white; cursor: pointer; }
                .instructions { text-align: left; margin-top: 25px; padding: 15px; border: 1px solid #ddd; border-radius: 5px; background: #f9f9f9; }
                .instructions summary { font-weight: bold; cursor: pointer; }
                .instructions ul { padding-left: 20px; }
                .instructions li { margin-bottom: 8px; }
                #results { margin-top: 20px; }
                .error { color: #d92323; margin-top: 10px; }
                .loading { color: #666; font-style: italic; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>YouTubio | ElfHosted</h1>
                ${process.env.EMBED || ""}
                <p>To see your subscriptions, watch history, and watch later playlists, paste the content of your <code>cookies.txt</code> file below.</p>
                <form id="config-form">
                    <textarea id="cookie-data" placeholder="Paste the content of your cookies.txt file here..."></textarea>
                    <button type="submit" class="install-button" id="submit-btn">Generate Install Link</button>
                    <div id="error-message" class="error" style="display:none;"></div>
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
                        <li>Click "Export", "Download", or "Copy" to save the <strong>cookies.txt</strong> file or contents.</li>
                            <ul>
                                <li>If you used "Export" or "Download", Open the file and copy its entire content.</li>
                            </ul>
                        <li>Paste the content into the text area above.</li>
                    </ol>
                </details>
            </div>
            <script>
                const host = '${host}';
                const protocol = '${protocol}';
                
                document.getElementById('config-form').addEventListener('submit', async function(event) {
                    event.preventDefault();
                    
                    const cookies = document.getElementById('cookie-data').value;
                    const submitBtn = document.getElementById('submit-btn');
                    const errorDiv = document.getElementById('error-message');
                    
                    if (!cookies || !cookies.trim()) {
                        errorDiv.textContent = "You must provide cookies to use this addon";
                        errorDiv.style.display = 'block';
                        return;
                    }
                    
                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Encrypting...';
                    errorDiv.style.display = 'none';
                    
                    try {
                        const response = await fetch('/encrypt', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ 
                                cookies: cookies,
                            })
                        });
                        
                        const data = await response.json();
                        
                        if (!response.ok || !data.success) {
                            throw new Error(data.error || 'Encryption failed');
                        }
                        
                        const installUrl = \`\${protocol}://\${host}/\${data.config}/manifest.json\`;
                        const installLink = document.getElementById('install-link');
                        installLink.href = \`stremio://installaddon/\${installUrl}\`;
                        
                        const installUrlInput = document.getElementById('install-url');
                        installUrlInput.value = installUrl;
                        
                        document.getElementById('results').style.display = 'block';
                        
                    } catch (error) {
                        errorDiv.textContent = error.message;
                        errorDiv.style.display = 'block';
                    } finally {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Generate Install Link';
                    }
                });

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
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start the server
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
